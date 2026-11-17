// fork(claude-agent)
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { FactoryDispatchError } from './dispatch-errors.js';

import { MastraCodeRuntimeSessions } from './mastra-code-sessions.js';

function fakeSession(
  over: { threadId?: string; pending?: boolean; running?: boolean; active?: boolean; ids?: string[] } = {},
) {
  return {
    thread: {
      getId: () => over.threadId ?? 't1',
      listActiveMessages: async () => (over.ids ?? []).map(id => ({ id })),
    },
    suspensions: { hasPending: () => over.pending ?? false },
    run: { isRunning: () => over.running ?? false },
    stream: { isActive: () => over.active ?? false },
    abort: vi.fn(),
  };
}

function setup(session?: ReturnType<typeof fakeSession>, runs: Array<{ runId: string; threadId: string }> = []) {
  const controller = {
    getSession: vi.fn(async () => session as never),
    listActiveThreadRuns: vi.fn(() => runs as never),
  };
  return { controller, sessions: new MastraCodeRuntimeSessions(controller) };
}

describe('MastraCodeRuntimeSessions', () => {
  it('runs: a live session by id', async () => {
    expect(await setup(fakeSession()).sessions.runs('s')).toBe(true);
    expect(await setup(undefined).sessions.runs('s')).toBe(false);
  });

  it('hasRun: the kickoff delivery on the session thread', async () => {
    const { sessions } = setup(fakeSession({ ids: ['k1'] }));
    expect(await sessions.hasRun('s', 'k1')).toBe(true);
    expect(await sessions.hasRun('s', 'k2')).toBe(false);
    expect(await setup(undefined).sessions.hasRun('s', 'k1')).toBe(false);
  });

  it('awaitsPerson: a pending suspension', async () => {
    expect(await setup(fakeSession({ pending: true })).sessions.awaitsPerson('s')).toBe(true);
    expect(await setup(fakeSession()).sessions.awaitsPerson('s')).toBe(false);
    expect(await setup(undefined).sessions.awaitsPerson('s')).toBe(false);
  });

  it('holdsThread: pending or running, only on the binding thread', async () => {
    expect(await setup(fakeSession({ running: true })).sessions.holdsThread('s', 't1')).toBe(true);
    expect(await setup(fakeSession({ pending: true })).sessions.holdsThread('s', 't1')).toBe(true);
    expect(await setup(fakeSession({ running: true })).sessions.holdsThread('s', 't2')).toBe(false);
    expect(await setup(fakeSession()).sessions.holdsThread('s', 't1')).toBe(false);
    expect(await setup(undefined).sessions.holdsThread('s', 't1')).toBe(false);
  });

  it('abort: only a session whose stream is active', async () => {
    const active = fakeSession({ active: true });
    await setup(active).sessions.abort('s');
    expect(active.abort).toHaveBeenCalledOnce();
    const idle = fakeSession();
    await setup(idle).sessions.abort('s');
    expect(idle.abort).not.toHaveBeenCalled();
  });

  it('isThreadRunning / anyRunning read the run registry', () => {
    const { sessions } = setup(undefined, [{ runId: 'r', threadId: 't1' }]);
    expect(sessions.isThreadRunning('t1')).toBe(true);
    expect(sessions.isThreadRunning('t2')).toBe(false);
    expect(sessions.anyRunning()).toBe(true);
    expect(setup(undefined).sessions.anyRunning()).toBe(false);
  });
});

describe('MastraCodeRuntimeSessions.message', () => {
  const ctx = () => {
    const c = new RequestContext();
    c.set('user', { workosId: 'u1', organizationId: 'o1' });
    return c;
  };
  function messaging(over: { threadId?: string; accepted?: unknown } = {}) {
    const send = vi.fn((_signal: unknown, _options: unknown) => ({
      persisted: Promise.resolve(),
      accepted: Promise.resolve(over.accepted ?? { action: 'deliver' }),
    }));
    const session = {
      ...fakeSession({ threadId: over.threadId ?? 't1' }),
      thread: {
        ...fakeSession().thread,
        getId: () => over.threadId ?? 't1',
        requireId: () => over.threadId ?? 't1',
        switch: vi.fn(async () => {}),
      },
      state: { get: () => ({}) },
      identity: { getId: () => 's', getOwnerId: () => 'u1', getResourceId: () => 'r1' },
      model: { get: () => 'm' },
      getWorkspace: () => undefined,
      sendNotificationSignal: send,
    };
    return { session, send, sessions: setup(session as never).sessions };
  }

  it('sends a notification with the rule message shape, as the session owner', async () => {
    const { session, send, sessions } = messaging();
    await sessions.message(
      's',
      {
        text: 'hello',
        source: 'rule-message',
        wake: true,
        priority: 'urgent',
        sourceId: 'rec1',
        idempotencyKey: 'idem',
        thread: { id: 't1', resourceId: 'r1' },
      },
      ctx(),
    );
    expect(session.thread.switch).not.toHaveBeenCalled();
    const [signal, options] = send.mock.calls[0]!;
    expect(signal).toEqual({
      source: 'factory',
      kind: 'rule-message',
      summary: 'hello',
      priority: 'urgent',
      payload: { message: 'hello' },
      sourceId: 'rec1',
      dedupeKey: 'idem',
    });
    expect(options).toMatchObject({ ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'wake' } });
  });

  it('persists when it should not wake, defaults to high, and switches to the message thread first', async () => {
    const { session, send, sessions } = messaging({ threadId: 'other' });
    await sessions.message(
      's',
      { text: 'x', source: 'rule-message', wake: false, thread: { id: 't1', resourceId: 'r1' } },
      ctx(),
    );
    expect(session.thread.switch).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }));
    const [signal, options] = send.mock.calls[0]!;
    expect(signal).toMatchObject({ priority: 'high' });
    expect(options).toMatchObject({ ifIdle: { behavior: 'persist' } });
  });

  it('fails as session_unavailable without a session, and as delivery failure when nothing reaches the agent', async () => {
    await expect(
      setup(undefined).sessions.message('s', { text: 'x', source: 'rule-message', wake: true }, ctx()),
    ).rejects.toMatchObject({ code: 'session_unavailable' });
    const { sessions } = messaging({ accepted: { action: 'persist' } });
    await expect(sessions.message('s', { text: 'x', source: 'rule-message', wake: true }, ctx())).rejects.toMatchObject(
      {
        code: 'notification_delivery_failed',
      },
    );
  });

  it('lets a thread-switch or session-lookup failure through unwrapped (it classifies as unknown, as before the seam)', async () => {
    const { session, sessions } = messaging({ threadId: 't0' });
    session.thread.switch.mockRejectedValueOnce(new Error('model credentials could not be resolved'));
    const failure = await sessions
      .message('s', { text: 'x', source: 'rule-message', wake: true, thread: { id: 't1', resourceId: 'r1' } }, ctx())
      .catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(FactoryDispatchError);
    expect(failure.message).toBe('model credentials could not be resolved');
  });
});
