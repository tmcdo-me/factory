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

describe('MastraCodeRuntimeSessions.kickoff', () => {
  type Listener = (event: Record<string, unknown>) => void;
  const ctx = () => {
    const c = new RequestContext();
    c.set('user', { workosId: 'u1', organizationId: 'o1' });
    return c;
  };
  /** A session whose kickoff signal wakes a run that `emit`s events to the watcher. */
  function liveSession(action: 'wake' | 'deliver' | 'none' = 'wake') {
    const listeners = new Set<Listener>();
    const sendSignal = vi.fn(() => ({
      accepted: Promise.resolve({ accepted: true as const, action: action === 'none' ? undefined : action }),
    }));
    const sendNotificationSignal = vi.fn(async () => ({}));
    const session = {
      ...fakeSession(),
      identity: { getResourceId: () => 'r1', getId: () => 's', getOwnerId: () => 'u1' },
      thread: { ...fakeSession().thread, requireId: () => 't1', switch: vi.fn() },
      model: { get: () => 'm' },
      state: { get: () => ({}) },
      getWorkspace: () => undefined,
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendSignal,
      sendNotificationSignal,
    };
    return {
      session,
      sendSignal,
      sendNotificationSignal,
      emit: (e: Record<string, unknown>) => listeners.forEach(l => l(e)),
      listeners,
    };
  }
  function kickoffSetup(live: ReturnType<typeof liveSession>) {
    const controller = {
      getSession: vi.fn(async () => live.session as never),
      listActiveThreadRuns: vi.fn(() => [] as never),
    };
    return new MastraCodeRuntimeSessions(controller, {
      timeoutMs: 60_000,
      autoApproving: new Set(),
      approver: () => undefined,
    });
  }
  const prompt = { runId: 'k1', prompt: 'do it', thread: { id: 't1', resourceId: 'r1' } };

  it('owns its goal', () => {
    expect(kickoffSetup(liveSession()).ownsGoal).toBe(true);
  });

  it('sends the prompt as a user signal under the run id, says the goal was delivered, and ends complete', async () => {
    const live = liveSession();
    const delivered = vi.fn(async () => {});
    const started = await kickoffSetup(live).kickoff(
      's',
      { ...prompt, description: 'the card', delivered, superseded: async () => false },
      ctx(),
    );
    expect(live.sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'k1', type: 'user', contents: expect.stringContaining('do it') }),
      expect.objectContaining({ requireDelivery: true }),
    );
    expect(delivered).toHaveBeenCalledOnce();
    live.emit({ type: 'agent_end', reason: 'complete' });
    expect(await started.ended).toMatchObject({ reason: 'complete' });
    expect(await (await started.ended).supersededAtEnd).toBe(false);
    expect(started.observedEnd()).toBe('complete');
    expect(live.listeners.size).toBe(0);
  });

  it('a prepared start goes as a run-kickoff notification, sent again under a retry key when it was queued onto a run that ended', async () => {
    const live = liveSession();
    const outputs = [{ action: 'deliver' }, { action: 'wake', output: { consumeStream: async () => {} } }];
    live.sendNotificationSignal.mockImplementation(
      async () =>
        ({
          persisted: Promise.resolve(),
          accepted: Promise.resolve(outputs.shift()),
        }) as never,
    );
    const notification = {
      sourceId: 'rec1',
      dedupeKey: 'factory-kickoff:k',
      retryDedupeKey: (generation: number) => `factory-kickoff:k:retry:${generation}`,
    };
    const pending = kickoffSetup(live).kickoff(
      's',
      {
        runId: 'factory-kickoff:k:1',
        prompt: 'begin',
        thread: prompt.thread,
        notification,
        label: 'Factory kickoff run',
      },
      ctx(),
    );
    // The run the first copy was queued onto ends without draining it.
    await vi.waitFor(() => expect(live.sendNotificationSignal).toHaveBeenCalledTimes(1));
    live.emit({ type: 'agent_end', reason: 'complete' });
    const started = await pending;
    expect(live.sendSignal).not.toHaveBeenCalled();
    const sent = live.sendNotificationSignal.mock.calls.map(([n]) => n);
    expect(sent[0]).toMatchObject({
      source: 'factory',
      kind: 'run-kickoff',
      summary: 'begin',
      sourceId: 'rec1',
      dedupeKey: 'factory-kickoff:k',
    });
    expect(sent[1]).toMatchObject({ dedupeKey: 'factory-kickoff:k:retry:1' });
    live.emit({ type: 'agent_end', reason: 'complete' });
    expect(await started.ended).toMatchObject({ reason: 'complete' });
  });

  describe('a delivery queued onto a run whose end is never seen', () => {
    const quick = (live: ReturnType<typeof liveSession>) =>
      new MastraCodeRuntimeSessions(
        { getSession: vi.fn(async () => live.session as never), listActiveThreadRuns: vi.fn(() => [] as never) },
        { timeoutMs: 20, autoApproving: new Set(), approver: () => undefined },
      );

    it('stays a plain, retryable error for a prepared start', async () => {
      const live = liveSession();
      live.sendNotificationSignal.mockImplementation(
        async () => ({ persisted: Promise.resolve(), accepted: Promise.resolve({ action: 'deliver' }) }) as never,
      );
      const error = await quick(live)
        .kickoff(
          's',
          {
            runId: 'factory-kickoff:k:1',
            prompt: 'begin',
            thread: prompt.thread,
            notification: { sourceId: 'rec1', dedupeKey: 'k', retryDedupeKey: g => `k:retry:${g}` },
          },
          ctx(),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(FactoryDispatchError);
      expect((error as Error).message).toContain('has not ended');
    });

    it("is the terminal run_terminal_event_missing for a decision's kickoff", async () => {
      const live = liveSession('deliver');
      await expect(quick(live).kickoff('s', prompt, ctx())).rejects.toMatchObject({
        code: 'run_terminal_event_missing',
      });
    });
  });

  it('closing a kickoff that nobody follows drops its watch and settles it, answering nothing more', async () => {
    const live = liveSession();
    const approve = vi.fn(async () => async () => {});
    const sessions = new MastraCodeRuntimeSessions(
      { getSession: vi.fn(async () => live.session as never), listActiveThreadRuns: vi.fn(() => [] as never) },
      { timeoutMs: 60_000, autoApproving: new Set(), approver: () => approve },
    );
    const started = await sessions.kickoff('s', { ...prompt, autoApprovedTool: 'submit_plan' }, ctx());
    expect(live.listeners.size).toBe(1);

    started.close();

    expect(live.listeners.size).toBe(0);
    const end = await started.ended;
    expect(end.reason).toBe('error');
    expect(end.failure).toMatchObject({ code: 'run_terminal_event_missing' });
    // A pause the dead watch would have answered after the close is no longer seen.
    live.emit({ type: 'tool_suspended', toolName: 'submit_plan', toolCallId: 'c1' });
    live.emit({ type: 'agent_end', reason: 'suspended' });
    expect(approve).not.toHaveBeenCalled();
  });

  it('a run that ends suspended resolves as awaiting a person', async () => {
    const live = liveSession();
    const started = await kickoffSetup(live).kickoff('s', prompt, ctx());
    live.emit({ type: 'tool_suspended', toolName: 'ask_user', toolCallId: 'c1' });
    live.emit({ type: 'agent_end', reason: 'suspended' });
    expect(await started.ended).toMatchObject({ reason: 'awaiting_interaction' });
  });

  it('a run that errors resolves with the failure the dispatcher records', async () => {
    const live = liveSession();
    const started = await kickoffSetup(live).kickoff('s', prompt, ctx());
    live.emit({ type: 'error', error: new Error('boom') });
    live.emit({ type: 'agent_end', reason: 'error' });
    const end = await started.ended;
    expect(end.reason).toBe('error');
    expect(end.failure).toBeInstanceOf(FactoryDispatchError);
    expect(end.failure?.message).toContain('boom');
  });

  it('a delivery with no named action is ambiguous, and its watch is closed', async () => {
    const live = liveSession('none');
    await expect(kickoffSetup(live).kickoff('s', prompt, ctx())).rejects.toMatchObject({
      code: 'skill_delivery_ambiguous',
    });
    expect(live.listeners.size).toBe(0);
  });

  it('a session that is gone is session_unavailable; a kickoff nobody wants any more stops after its preface', async () => {
    const gone = new MastraCodeRuntimeSessions(
      { getSession: vi.fn(async () => undefined), listActiveThreadRuns: vi.fn(() => []) },
      { timeoutMs: 1, autoApproving: new Set(), approver: () => undefined },
    );
    await expect(gone.kickoff('s', prompt, ctx())).rejects.toMatchObject({ code: 'session_unavailable' });
    const live = liveSession();
    await expect(
      kickoffSetup(live).kickoff('s', { ...prompt, preface: 'moving on', stillWanted: async () => false }, ctx()),
    ).rejects.toThrow();
    expect(live.sendNotificationSignal).toHaveBeenCalledOnce();
    expect(live.sendSignal).not.toHaveBeenCalled();
  });
});
