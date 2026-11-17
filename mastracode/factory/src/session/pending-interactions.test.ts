// fork(claude-agent)
import { InMemoryEventLog, InMemoryInteractionStore, InteractionBroker, SessionEventHub } from '@factory/agent-runtime';
import type { InteractionRecord } from '@factory/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import type { LiveSession } from './live-sessions.js';
import { LiveSessions } from './live-sessions.js';
import {
  FallbackInteractionStore,
  PendingInteractions,
  alsoParked,
  answersWithDecision,
  interactionToolName,
  waitingReport,
} from './pending-interactions.js';

const PROJECTS: Record<string, { orgId: string; factoryProjectId: string | null }> = {
  's-plan': { orgId: 'org-1', factoryProjectId: 'project-1' },
  's-ask': { orgId: 'org-1', factoryProjectId: 'project-1' },
  's-other': { orgId: 'org-1', factoryProjectId: 'project-2' },
  's-mine': { orgId: 'org-1', factoryProjectId: null },
};

function setup(store = new InMemoryInteractionStore()) {
  const changed: string[] = [];
  const requested: InteractionRecord[] = [];
  const projectOf = vi.fn(async (sessionId: string) => PROJECTS[sessionId] ?? null);
  const pending = new PendingInteractions({
    store,
    projectOf,
    onChanged: (sessionId, project) => changed.push(`${sessionId}@${project.factoryProjectId}`),
    onRequested: record => requested.push(record),
  });
  const broker = new InteractionBroker({ store: pending, hub: new SessionEventHub(new InMemoryEventLog()) });
  return { pending, broker, store, changed, requested, projectOf };
}

const plan = { kind: 'plan_approval', planPath: '.artifacts/plans/a.md' } as const;
const question = { kind: 'question', question: 'Ship it?' } as const;

describe('PendingInteractions', () => {
  it('reports a session waiting on a person as parked on the tool that asked, until it is answered', async () => {
    const { pending, broker, changed, requested } = setup();
    const answer = broker.request('s-plan', plan, { callId: 'toolu_plan' });
    await vi.waitFor(() => expect(changed).toEqual(['s-plan@project-1']));

    const parked = pending.parked('s-plan');
    // What it asks comes with it, so it can be answered from outside the session.
    expect(parked).toEqual({
      toolName: 'submit_plan',
      suspendedAt: expect.any(Number),
      interaction: { toolCallId: 'toolu_plan', interactionId: expect.any(String), request: plan },
    });
    expect(pending.parkedIn('project-1')).toEqual([{ sessionId: 's-plan', run: parked }]);
    expect(pending.parkedIn('project-2')).toEqual([]);
    // Its followers hear once, as it asks.
    expect(requested).toMatchObject([{ sessionId: 's-plan', callId: 'toolu_plan', request: plan }]);

    const [record] = await broker.listPending({ sessionId: 's-plan' });
    await broker.resolve(record!.id, { kind: 'plan_approval', action: 'approved' });
    await expect(answer).resolves.toEqual({ kind: 'plan_approval', action: 'approved' });
    expect(pending.parked('s-plan')).toBeUndefined();
    expect(pending.parkedIn('project-1')).toEqual([]);
    expect(changed).toEqual(['s-plan@project-1', 's-plan@project-1']);
  });

  it('shows what a session waited on longest, each wait dated apart so a receipt never carries over', async () => {
    const { pending, broker } = setup();
    void broker.request('s-ask', question, { callId: 'toolu_1' }).catch(() => {});
    void broker.request('s-ask', plan, { callId: 'toolu_2' });
    await vi.waitFor(async () => expect(await broker.listPending({ sessionId: 's-ask' })).toHaveLength(2));

    const first = pending.parked('s-ask');
    expect(first?.toolName).toBe('ask_user');
    const [asked] = await broker.listPending({ sessionId: 's-ask' });
    await broker.cancel(asked!.id, 'aborted');
    const second = pending.parked('s-ask');
    expect(second?.toolName).toBe('submit_plan');
    expect(second!.suspendedAt).toBeGreaterThan(first!.suspendedAt);
  });

  it('picks up what was still pending before a restart, without telling followers again', async () => {
    const store = new InMemoryInteractionStore();
    await store.create({
      id: 'int-old',
      sessionId: 's-plan',
      callId: 'toolu_old',
      request: plan,
      requestedAt: '2030-01-01T00:00:00.000Z',
      status: 'pending',
    });
    const { pending, changed, requested } = setup(store);
    await pending.load();
    await vi.waitFor(() => expect(changed).toEqual(['s-plan@project-1']));

    expect(pending.parked('s-plan')).toMatchObject({
      toolName: 'submit_plan',
      suspendedAt: new Date('2030-01-01T00:00:00.000Z').getTime(),
    });
    expect(requested).toEqual([]);
  });

  it("lists a session outside any project nowhere, and retries a project it couldn't read", async () => {
    const { pending, broker, projectOf, changed } = setup();
    void broker.request('s-mine', question, { callId: 'toolu_mine' });
    await vi.waitFor(() => expect(projectOf).toHaveBeenCalledWith('s-mine'));
    expect(pending.parked('s-mine')).toMatchObject({ toolName: 'ask_user' });
    expect(pending.parkedIn('project-1')).toEqual([]);

    projectOf.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    void broker.request('s-other', question, { callId: 'toolu_a' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(pending.parkedIn('project-2')).toEqual([]);
    void broker.request('s-other', plan, { callId: 'toolu_b' });
    await vi.waitFor(() => expect(changed).toContain('s-other@project-2'));
    expect(pending.parkedIn('project-2')).toHaveLength(1);
    warn.mockRestore();
  });

  // fork(claude-agent): a question a run's turn ended on in plain text was asked by no tool call.
  it('names a question no tool call asked by its interaction, so it can still be answered from outside', async () => {
    const { pending, broker } = setup();
    void broker.request('s-ask', question);
    await vi.waitFor(() => expect(pending.parked('s-ask')).toBeDefined());
    const [record] = await broker.listPending({ sessionId: 's-ask' });
    expect(pending.parked('s-ask')).toEqual({
      toolName: 'ask_user',
      suspendedAt: expect.any(Number),
      interaction: { interactionId: record!.id, request: question },
    });
  });

  it('adds Claude Agent sessions to the live registry, beside the controller sessions it parks', async () => {
    const { pending, broker } = setup();
    const registry = alsoParked(
      new LiveSessions({ onSessionCreated: () => () => {}, onSessionDeleted: () => () => {} }),
      pending,
    );
    expect(registry.parked('s-plan')).toBeUndefined();
    void broker.request('s-plan', plan, { callId: 'toolu_plan' });
    await vi.waitFor(() => expect(registry.parkedIn('project-1')).toHaveLength(1));
    expect(registry.parked('s-plan')).toMatchObject({ toolName: 'submit_plan' });
    expect(registry.parkedIn('project-1')[0]).toMatchObject({ sessionId: 's-plan' });
  });

  // Slice 5b: a Mastra Code session's waiting calls are broker records its controller holds.
  // After a restart a gate's run is gone, but its approval persisted and can still be answered.
  it('counts a gated call as a parked run once its run is no longer in flight', async () => {
    const running = new Set(['s-plan']);
    const pending = new PendingInteractions({
      store: new InMemoryInteractionStore(),
      projectOf: async sessionId => PROJECTS[sessionId] ?? null,
      isRunning: sessionId => running.has(sessionId),
    });
    const broker = new InteractionBroker({ store: pending, hub: new SessionEventHub(new InMemoryEventLog()) });
    await broker.track({
      id: 'tool_approval:call-gate',
      sessionId: 's-plan',
      callId: 'call-gate',
      heldBy: 'mastra-code',
      request: { kind: 'tool_approval', toolName: 'ship_release', input: {}, gate: true },
      requestedAt: new Date().toISOString(),
    });

    expect(pending.parked('s-plan')).toBeUndefined();
    running.delete('s-plan');
    expect(pending.parked('s-plan')).toMatchObject({ toolName: 'ship_release' });
  });

  it("lists and settles a Mastra Code session's calls from memory while its store fails", async () => {
    class FailingStore extends InMemoryInteractionStore {
      override async create(): Promise<void> {
        throw new Error('database is locked');
      }
      override async settle(): Promise<undefined> {
        throw new Error('database is locked');
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = new PendingInteractions({ store: new FailingStore(), projectOf: async () => null });
    const broker = new InteractionBroker({ store: pending, hub: new SessionEventHub(new InMemoryEventLog()) });
    const held = await broker.track({
      id: 'question:call-ask',
      sessionId: 's-ask',
      callId: 'call-ask',
      heldBy: 'mastra-code',
      request: question,
      requestedAt: new Date().toISOString(),
    });

    expect(pending.parked('s-ask')).toMatchObject({ toolName: 'ask_user' });
    expect(await pending.get(held.id)).toMatchObject({ status: 'pending' });
    // Its runtime already settled it: the failed write is logged, not reported to whoever answered.
    await expect(broker.settleHeld(held.id, { status: 'cancelled', reason: 'aborted' })).resolves.toBe(true);
    expect(pending.parked('s-ask')).toBeUndefined();
    // A Claude Agent question is not taken in memory: its tool must hear the write failed.
    await expect(broker.request('s-plan', plan, { callId: 'toolu_plan' })).rejects.toThrow('locked');
    warn.mockRestore();
  });

  it('keeps what sessions wait on in memory when the storage domain fails to start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = Object.assign(new InMemoryInteractionStore(), {
      ensureReady: async () => {
        throw new Error('migration failed');
      },
    });
    const store = new FallbackInteractionStore(broken);
    await store.create({
      id: 'question:call-ask',
      sessionId: 's-ask',
      request: question,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });

    expect(await store.listPending()).toHaveLength(1);
    expect(await broken.listPending()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("reports a Mastra Code session's paused call as parked, but not a call waiting at its approval gate", async () => {
    const { pending, broker, requested } = setup();
    const held = (id: string, sessionId: string, request: InteractionRecord['request']) =>
      broker.track({
        id,
        sessionId,
        callId: id.split(':')[1],
        heldBy: 'mastra-code',
        request,
        requestedAt: new Date().toISOString(),
      });
    await held('question:call-ask', 's-ask', question);
    await held('tool_approval:call-gate', 's-plan', {
      kind: 'tool_approval',
      toolName: 'ship_release',
      input: {},
      gate: true,
    });

    await vi.waitFor(() => expect(pending.parkedIn('project-1')).toHaveLength(1));
    // Named by its tool call, as the controller takes the answer.
    expect(pending.parked('s-ask')).toEqual({
      toolName: 'ask_user',
      suspendedAt: expect.any(Number),
      interaction: { toolCallId: 'call-ask', request: question },
    });
    expect(pending.parked('s-plan')).toBeUndefined();
    expect(pending.waitingOn('s-plan', 'call-gate')).toHaveLength(1);
    // The controller's own reports tell followers, until slice 5d.
    expect(requested).toEqual([]);
  });

  it('lists a tool that resumes on input of its own as parked, with nothing to answer from outside', async () => {
    const { pending, broker } = setup();
    await broker.track({
      id: 'tool_input:call-access',
      sessionId: 's-ask',
      callId: 'call-access',
      heldBy: 'mastra-code',
      request: { kind: 'tool_input', toolName: 'request_access', input: { path: '/etc' } },
      requestedAt: new Date().toISOString(),
    });

    expect(pending.parked('s-ask')).toEqual({ toolName: 'request_access', suspendedAt: expect.any(Number) });
  });

  it('names each request by the tool that asks it, and says which a yes or no answers', () => {
    expect(interactionToolName(plan)).toBe('submit_plan');
    expect(interactionToolName(question)).toBe('ask_user');
    expect(interactionToolName({ kind: 'tool_approval', toolName: 'factory_delete', input: {} })).toBe(
      'factory_delete',
    );
    expect(answersWithDecision(plan)).toBe(true);
    expect(answersWithDecision({ kind: 'tool_approval', toolName: 'x', input: {} })).toBe(true);
    expect(answersWithDecision(question)).toBe(false);
  });

  it('tells followers the call it waits on, so a plan can be answered from where they are', () => {
    const base = {
      id: 'int-1',
      sessionId: 's-plan',
      requestedAt: '2030-01-01T00:00:00.000Z',
      status: 'pending',
    } as const;
    expect(waitingReport({ ...base, callId: 'toolu_plan', request: plan })).toEqual({
      sessionId: 's-plan',
      threadId: 's-plan',
      since: new Date('2030-01-01T00:00:00.000Z'),
      outcome: { status: 'blocked', toolName: 'submit_plan', toolCallId: 'toolu_plan', decision: true },
    });
    // A question takes a typed answer in the session: no yes or no is offered.
    expect(waitingReport({ ...base, callId: 'toolu_ask', request: question }).outcome).toEqual({
      status: 'blocked',
      toolName: 'ask_user',
      toolCallId: 'toolu_ask',
    });
  });

  it("keeps each wait's receipt key across a restart, two waits in one millisecond included", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
    try {
      const store = new InMemoryInteractionStore();
      const { pending, broker } = setup(store);
      void broker.request('s-ask', question, { callId: 'toolu_1' }).catch(() => {});
      void broker.request('s-ask', plan, { callId: 'toolu_2' }).catch(() => {});
      await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's-ask' })).toHaveLength(2));
      const keys = (await store.listPending({ sessionId: 's-ask' })).map(record => Date.parse(record.requestedAt));
      expect(keys[1]).toBe(keys[0]! + 1);
      expect(pending.parked('s-ask')?.suspendedAt).toBe(keys[0]);

      // The next process reads the same keys from what was stored.
      const after = setup(store).pending;
      await after.load();
      expect(after.parked('s-ask')?.suspendedAt).toBe(keys[0]);
      const [first] = await store.listPending({ sessionId: 's-ask' });
      await after.settle(first!.id, {
        status: 'cancelled',
        cancelReason: 'aborted',
        settledAt: new Date().toISOString(),
      });
      expect(after.parked('s-ask')?.suspendedAt).toBe(keys[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never indexes a record answered while the start-up read was under way', async () => {
    const store = new InMemoryInteractionStore();
    const base = { sessionId: 's-plan', request: plan, status: 'pending' } as const;
    await store.create({ ...base, id: 'int-1', callId: 'toolu_1', requestedAt: '2030-01-01T00:00:00.000Z' });
    await store.create({ ...base, id: 'int-2', callId: 'toolu_2', requestedAt: '2030-01-01T00:00:01.000Z' });
    const { pending } = setup(store);
    // Answered between the list and the per-record read.
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(async id => {
      if (id === 'int-1') {
        await pending.settle('int-1', {
          status: 'resolved',
          response: { kind: 'plan_approval', action: 'approved' },
          settledAt: new Date().toISOString(),
        });
      }
      return get(id);
    });
    await pending.load();

    expect(pending.parked('s-plan')).toMatchObject({
      toolName: 'submit_plan',
      suspendedAt: Date.parse('2030-01-01T00:00:01.000Z'),
    });
  });
});
