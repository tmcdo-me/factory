// fork(claude-agent)
import { describe, expect, it, vi } from 'vitest';

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
