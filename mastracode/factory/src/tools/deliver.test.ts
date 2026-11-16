import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import type { SourceControlSession } from '../storage/domains/source-control/base.js';
import {
  RUNTIME_DELIVERIES_TTL_MS,
  RUNTIME_DELIVERY_THREADS_KEPT,
  deliverFactorySessionNotification,
  recentRuntimeDeliveries,
  resolveSessionThread,
} from './deliver.js';
import type { FactoryDeliveryController } from './deliver.js';

const ROW = {
  sessionId: 'session-b',
  orgId: 'org-1',
  userId: 'user-b',
  factoryProjectId: 'project-1',
  projectRepositoryId: 'repo-link-1',
} as SourceControlSession;

// The target is a run: its run binding lets it run on the Factory's resource.
const RUNS = { hasRunBindingForSession: vi.fn(async () => true) };

const MESSAGE = { kind: 'message', summary: 'Can you check the failing test?', priority: 'medium' as const };

function fakeSession(currentThreadId: string, running = false) {
  return {
    thread: { getId: vi.fn(() => currentThreadId), switch: vi.fn() },
    state: { get: () => ({}), set: vi.fn() },
    stream: { isActive: () => running },
    sendNotificationSignal: vi.fn(),
  };
}

function setup({
  // Sessions share their Factory's resource; the stamp ties the thread to its session.
  thread = { id: 'thread-stored', resourceId: 'project-1', metadata: { factorySessionId: 'session-b' } } as {
    id: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  } | null,
  offline = false,
  row = ROW as SourceControlSession | null,
  action = 'deliver',
  liveThreadId = 'thread-other',
  running = false,
} = {}) {
  const live = offline ? undefined : fakeSession(liveThreadId, running);
  const calls: string[] = [];
  const created = fakeSession('thread-stored');
  const agent = {
    sendNotificationSignal: vi.fn(async () => {
      calls.push('send');
      return { record: { id: 'notification-1' }, decision: { action }, persisted: Promise.resolve() };
    }),
  };
  const controller = {
    queryThreadById: vi.fn(async () => thread),
    queryThreads: vi.fn(async () => []),
    getSession: vi.fn(async () => live),
    createSession: vi.fn(async () => {
      calls.push('create');
      return created;
    }),
    getCurrentAgent: vi.fn(() => agent),
  };
  const sessions = { getBySessionId: vi.fn(async () => row) };
  return {
    calls,
    live,
    agent,
    created,
    controller,
    sessions,
    deliver: (options: { onlyIfLive?: boolean } = {}) =>
      deliverFactorySessionNotification({
        controller: controller as unknown as FactoryDeliveryController,
        sessions,
        runs: RUNS,
        target: { sessionId: 'session-b', threadId: 'thread-stored' },
        notification: MESSAGE,
        ...options,
      }),
  };
}

describe('deliverFactorySessionNotification', () => {
  it('sends to a live target through its agent on the stored thread, without switching threads', async () => {
    const { agent, controller, live, deliver } = setup();

    await expect(deliver()).resolves.toEqual({ delivered: 'woken', notificationId: 'notification-1' });

    expect(agent.sendNotificationSignal).toHaveBeenCalledTimes(1);
    expect(agent.sendNotificationSignal).toHaveBeenCalledWith(
      { ...MESSAGE, source: 'factory-session' },
      { resourceId: 'project-1', threadId: 'thread-stored' },
    );
    expect(live?.sendNotificationSignal).not.toHaveBeenCalled();
    expect(live?.thread.switch).not.toHaveBeenCalled();
    expect(controller.createSession).not.toHaveBeenCalled();
  });

  it('says mid-run only when the target thread itself is running (#27742)', async () => {
    await expect(setup({ running: true, liveThreadId: 'thread-stored' }).deliver()).resolves.toMatchObject({
      delivered: 'mid-run',
    });
    await expect(setup({ running: true, liveThreadId: 'thread-other' }).deliver()).resolves.toMatchObject({
      delivered: 'woken',
    });
  });

  it('refuses a thread that belongs to another resource, without looking up, creating or sending', async () => {
    const { agent, controller, deliver } = setup({
      offline: true,
      thread: { id: 'thread-stored', resourceId: 'session-victim' },
    });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-owned' });
    expect(controller.getSession).not.toHaveBeenCalled();
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it("refuses another session's thread in the same Factory resource", async () => {
    const { agent, controller, deliver } = setup({
      offline: true,
      thread: { id: 'thread-stored', resourceId: 'project-1', metadata: { factorySessionId: 'session-victim' } },
    });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-owned' });
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it('creates an offline target as its row owner on the stored thread before sending', async () => {
    const { calls, controller, created, agent, deliver } = setup({ offline: true });

    await deliver();

    expect(calls).toEqual(['create', 'send']);
    expect(controller.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-b',
        ownerId: 'user-b',
        resourceId: 'project-1',
        threadId: 'thread-stored',
        tags: { factoryProjectId: 'project-1', projectRepositoryId: 'repo-link-1' },
      }),
    );
    const { requestContext } = (controller.createSession.mock.calls[0] as unknown as [{ requestContext: any }])[0];
    expect(requestContext.get('user')).toEqual({ workosId: 'user-b', organizationId: 'org-1' });
    expect(created.state.set).toHaveBeenCalledWith(expect.objectContaining({ factoryOrgId: 'org-1' }));
    expect(controller.getCurrentAgent).toHaveBeenCalledWith(created);
    expect(agent.sendNotificationSignal).toHaveBeenCalledWith(expect.anything(), {
      resourceId: 'project-1',
      threadId: 'thread-stored',
    });
  });

  it('skips a missing thread without creating or sending', async () => {
    const { controller, agent, deliver } = setup({ thread: null, offline: true });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-found' });
    expect(controller.getSession).not.toHaveBeenCalled();
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it("skips a thread another resource stamped with the target's session id", async () => {
    const { controller, agent, deliver } = setup({
      thread: { id: 'thread-forged', resourceId: 'user-atk', metadata: { factorySessionId: 'session-b' } },
    });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-owned' });
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it("skips a thread created with the target's session id under another resource", async () => {
    const { controller, agent, deliver } = setup({ thread: { id: 'session-b', resourceId: 'user-atk' } });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-owned' });
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it("skips a thread under the Factory stamped with a private run's session id", async () => {
    // Any org member can stamp a Factory thread; a private run's stamp doesn't count there.
    const { controller, agent, deliver } = setup({
      row: { ...ROW, visibility: 'private' } as SourceControlSession,
      thread: { id: 'thread-stamped', resourceId: 'project-1', metadata: { factorySessionId: 'session-b' } },
    });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-owned' });
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it('skips a thread under the Factory for a session no run is bound to', async () => {
    // A person's session runs under its owner, so a thread under the Factory isn't its own.
    RUNS.hasRunBindingForSession.mockResolvedValueOnce(false);
    const { controller, agent, deliver } = setup({ thread: { id: 'session-b', resourceId: 'project-1' } });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'thread-not-owned' });
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it('skips an offline target with no Factory session row without creating or sending', async () => {
    const { controller, agent, deliver } = setup({
      offline: true,
      row: null,
      thread: { id: 'session-b', resourceId: 'session-b' },
    });
    await expect(deliver()).resolves.toEqual({ delivered: 'skipped', reason: 'session-not-found' });
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it('with onlyIfLive, skips an offline target without creating or sending', async () => {
    const { controller, sessions, agent, deliver } = setup({
      offline: true,
      thread: { id: 'session-b', resourceId: 'session-b' },
    });
    await expect(deliver({ onlyIfLive: true })).resolves.toEqual({ delivered: 'skipped', reason: 'offline' });
    expect(sessions.getBySessionId).not.toHaveBeenCalled();
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
  });

  it.each([
    ['summarize', 'summarized'],
    ['persist', 'persisted'],
    ['defer', 'persisted'],
    ['queue', 'persisted'],
  ])('maps a %s verdict to %s', async (action, delivered) => {
    const { deliver } = setup({ action });
    await expect(deliver()).resolves.toMatchObject({ delivered, notificationId: 'notification-1' });
  });

  it('reports a discarded notification as skipped', async () => {
    const { deliver } = setup({ action: 'discard' });
    await expect(deliver()).resolves.toEqual({
      delivered: 'skipped',
      notificationId: 'notification-1',
      reason: 'discarded',
    });
  });

  it('stores the record on the target thread and resource, which deferred re-dispatch reuses', async () => {
    const storage = new InMemoryStore();
    const agent = new Agent({
      id: 'factory-agent',
      name: 'factory-agent',
      instructions: 'test',
      model: 'openai/gpt-4o',
    });
    new Mastra({ agents: { agent }, storage, logger: false });
    const live = fakeSession('thread-other');
    const controller = {
      queryThreadById: vi.fn(async () => ({
        id: 'thread-stored',
        resourceId: 'project-1',
        metadata: { factorySessionId: 'session-b' },
      })),
      queryThreads: vi.fn(),
      getSession: vi.fn(async () => live),
      createSession: vi.fn(),
      getCurrentAgent: vi.fn(() => agent),
    };

    // `low` is always summarized later, so nothing runs and no model is needed.
    const result = await deliverFactorySessionNotification({
      controller: controller as unknown as FactoryDeliveryController,
      sessions: { getBySessionId: vi.fn(async () => ROW) },
      runs: RUNS,
      target: { sessionId: 'session-b', threadId: 'thread-stored' },
      notification: { ...MESSAGE, priority: 'low', attributes: { 'from-session': 'session-a' } },
    });

    expect(result.delivered).toBe('summarized');
    const notifications = await storage.getStore('notifications');
    const records = await notifications!.listNotifications({ threadId: 'thread-stored', source: 'factory-session' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: result.notificationId,
      threadId: 'thread-stored',
      resourceId: 'project-1',
      source: 'factory-session',
      kind: 'message',
      attributes: { 'from-session': 'session-a' },
    });
    expect(live.thread.switch).not.toHaveBeenCalled();
  });
});

describe('resolveSessionThread', () => {
  function threadSetup({
    binding = null as { threadId: string } | null,
    current = undefined as string | undefined,
    threads = [] as { id: string; updatedAt: Date }[],
  } = {}) {
    return resolveSessionThread({
      controller: {
        getSession: vi.fn(async () => (current ? fakeSession(current) : undefined)),
        queryThreadById: vi.fn(async () => null),
        queryThreads: vi.fn(async () => threads),
      } as unknown as FactoryDeliveryController,
      sessions: { getBySessionId: vi.fn(async () => ROW) },
      workItems: { findActiveRunBindingForSession: vi.fn(async () => binding), ...RUNS } as never,
      sessionId: 'session-b',
    });
  }

  it("prefers the role binding's thread over the session's current thread", async () => {
    await expect(threadSetup({ binding: { threadId: 'thread-role' }, current: 'thread-open' })).resolves.toBe(
      'thread-role',
    );
  });

  it('falls back to the thread the live session has open', async () => {
    await expect(threadSetup({ current: 'thread-open' })).resolves.toBe('thread-open');
  });

  it('falls back to the most recently updated thread, else null', async () => {
    await expect(
      threadSetup({
        threads: [
          { id: 'old', updatedAt: new Date('2026-10-01') },
          { id: 'new', updatedAt: new Date('2026-10-10') },
        ],
      }),
    ).resolves.toBe('new');
    await expect(threadSetup()).resolves.toBeNull();
  });
});

// fork(claude-agent)
describe('deliverFactorySessionNotification to a Claude Agent session', () => {
  function onRuntime(running = false) {
    const { controller, sessions, agent, calls } = setup();
    const message = vi.fn(async (...args: unknown[]) =>
      (args[1] as { wake: boolean }).wake ? { runId: 'run-7' } : {},
    );
    const runtime = { runs: vi.fn(async () => true), isRunning: () => running, message };
    const deliver = (
      notification: Parameters<typeof deliverFactorySessionNotification>[0]['notification'],
      onlyIfLive = false,
    ) =>
      deliverFactorySessionNotification({
        controller: controller as unknown as FactoryDeliveryController,
        sessions,
        runs: RUNS,
        target: { sessionId: 'session-b', threadId: 'thread-stored' },
        notification,
        onlyIfLive,
        runtime,
      });
    return { deliver, message, agent, calls, controller };
  }

  it('wakes it through its runtime, as its row owner, with what the message says about itself', async () => {
    const { deliver, message, agent, calls } = onRuntime();
    const result = await deliver({ ...MESSAGE, attributes: { 'from-session': 'session-a' } });

    // The turn that carries the message names it.
    expect(result).toEqual({ delivered: 'woken', notificationId: 'run-7' });
    const [sessionId, sent, requestContext] = message.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { get(key: string): unknown },
    ];
    expect(sessionId).toBe('session-b');
    expect(sent).toEqual({
      text: 'Can you check the failing test?',
      source: 'factory-session',
      wake: true,
      attributes: { kind: 'message', 'from-session': 'session-a' },
    });
    expect(requestContext.get('user')).toEqual({ workosId: 'user-b', organizationId: 'org-1' });
    // The controller session is never woken or created.
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('reaches a busy session with its next turn, and holds low-priority news and stage notices for later', async () => {
    const busy = onRuntime(true);
    await expect(busy.deliver(MESSAGE)).resolves.toMatchObject({ delivered: 'mid-run' });

    const later = onRuntime();
    // Held in memory for the next turn: nothing stored, so no notification is claimed.
    await expect(later.deliver({ ...MESSAGE, priority: 'low' })).resolves.toEqual({
      delivered: 'held',
      reason: 'next-turn',
    });
    await expect(later.deliver({ ...MESSAGE, kind: 'stage' }, true)).resolves.toEqual({
      delivered: 'held',
      reason: 'next-turn',
    });
    expect(later.message.mock.calls.map(call => (call[1] as { wake: boolean }).wake)).toEqual([false, false]);
  });

  it("fails, and never wakes the controller session, when the target's runtime can't be read", async () => {
    const { controller, sessions, agent, calls } = setup();
    await expect(
      deliverFactorySessionNotification({
        controller: controller as unknown as FactoryDeliveryController,
        sessions,
        runs: RUNS,
        target: { sessionId: 'session-b', threadId: 'thread-stored' },
        notification: MESSAGE,
        runtime: { runs: async () => Promise.reject(new Error('db down')), isRunning: () => false, message: vi.fn() },
      }),
    ).rejects.toThrow('db down');
    expect(agent.sendNotificationSignal).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('remembers deliveries for a bounded number of threads, and forgets stale ones', async () => {
    const { controller, sessions } = setup();
    const runtime = { runs: async () => true, isRunning: () => false, message: vi.fn(async () => ({})) };
    const deliverTo = (threadId: string) =>
      deliverFactorySessionNotification({
        controller: controller as unknown as FactoryDeliveryController,
        sessions,
        runs: RUNS,
        target: { sessionId: 'session-b', threadId },
        notification: { ...MESSAGE, priority: 'low' },
        runtime,
      });
    // Later than every delivery the tests above made, so the map's order is the clock's.
    vi.useFakeTimers({ now: Date.now() + 24 * RUNTIME_DELIVERIES_TTL_MS });
    try {
      await deliverTo('thread-stale');
      vi.setSystemTime(Date.now() + RUNTIME_DELIVERIES_TTL_MS + 1);
      await deliverTo('thread-kept');
      // Gone once its newest delivery is past the time anything still counts it.
      expect(recentRuntimeDeliveries('thread-stale')).toEqual([]);
      expect(recentRuntimeDeliveries('thread-kept')).toHaveLength(1);

      for (let index = 0; index < RUNTIME_DELIVERY_THREADS_KEPT; index += 1) await deliverTo(`thread-${index}`);
      // The least recently delivered thread made way; a thread delivered to again moves to the back.
      expect(recentRuntimeDeliveries('thread-kept')).toEqual([]);
      await deliverTo('thread-0');
      await deliverTo('thread-new');
      expect(recentRuntimeDeliveries('thread-0')).toHaveLength(2);
      expect(recentRuntimeDeliveries('thread-1')).toEqual([]);
      expect(recentRuntimeDeliveries('thread-new')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
