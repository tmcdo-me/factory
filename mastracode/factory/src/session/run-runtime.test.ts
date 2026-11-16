// fork(claude-agent)
import { InMemoryEventLog } from '@factory/agent-runtime';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';
import { createRunRuntimes } from './run-runtime.js';

const minted = { orgId: 'org-1', factoryProjectId: 'project-1', cardSession: false };

async function setup(options: { talked?: string[]; authOff?: boolean } = {}) {
  const storage = new LibSQLFactoryStorage({ id: 'run-runtime-test', url: ':memory:' });
  const sessions = storage.registerDomain(new AgentSessionsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  const events = new InMemoryEventLog();
  const runtimes = createRunRuntimes({
    sessions,
    events,
    threadHasMessages: async threadId => options.talked?.includes(threadId) ?? false,
    unscopedDefaults: () => options.authOff ?? false,
    ownConversation: ['claude-agent'],
  });
  await sessions.setProjectDefault({ orgId: 'org-1', projectId: 'project-1' }, 'claude-agent');
  return { sessions, events, runtimes };
}

describe('createRunRuntimes', () => {
  it("gives a session this start minted its project's default, and records it", async () => {
    const { sessions, runtimes } = await setup();
    expect(await runtimes.sessionRuntime({ ...minted, sessionId: 's1' })).toBe('claude-agent');
    expect(await sessions.get('s1')).toMatchObject({ runtimeId: 'claude-agent' });
    expect(runtimes.ownsConversation('claude-agent')).toBe(true);
    expect(runtimes.ownsConversation('mastra-code')).toBe(false);
  });

  it('keeps a session on the runtime it has', async () => {
    const { sessions, runtimes } = await setup();
    await sessions.assign('s1', 'mastra-code');
    expect(await runtimes.sessionRuntime({ ...minted, sessionId: 's1' })).toBe('mastra-code');
  });

  it('never moves a session that already worked onto the default, recording nothing', async () => {
    // s-old ran on Mastra Code before the event mirror existed: messages in its thread, no events.
    const { sessions, events, runtimes } = await setup({ talked: ['s-old'] });
    await events.append('s-events', [{ type: 'run.started', runId: 'r1' }]);

    expect(await runtimes.sessionRuntime({ ...minted, sessionId: 's-old' })).toBe('mastra-code');
    expect(await runtimes.sessionRuntime({ ...minted, sessionId: 's-events' })).toBe('mastra-code');
    // The card already holds s-card for a role: it is not new to this start, even if it never ran.
    expect(await runtimes.sessionRuntime({ ...minted, cardSession: true, sessionId: 's-card' })).toBe('mastra-code');
    for (const id of ['s-old', 's-events', 's-card']) expect(await sessions.get(id)).toBeUndefined();
  });

  it('runs on Mastra Code when the project has no default, and fails for a retry when it cannot tell', async () => {
    const { runtimes } = await setup();
    expect(await runtimes.sessionRuntime({ ...minted, factoryProjectId: 'other', sessionId: 's1' })).toBe(
      'mastra-code',
    );
    const broken = createRunRuntimes({
      sessions: {
        get: vi.fn(async () => Promise.reject(new Error('db down'))),
        assign: vi.fn(),
        getProjectDefault: vi.fn(),
      },
      events: new InMemoryEventLog(),
      threadHasMessages: async () => false,
      unscopedDefaults: () => false,
      ownConversation: ['claude-agent'],
    });
    // A Claude Agent session whose record can't be read must not be guessed onto Mastra Code.
    await expect(broken.sessionRuntime({ ...minted, sessionId: 's1' })).rejects.toMatchObject({
      code: 'session_unavailable',
    });
  });

  it("reads a default filed under the unscoped org only with auth off, never for another org's project", async () => {
    const authOn = await setup();
    await authOn.sessions.setProjectDefault({ orgId: 'local', projectId: 'project-2' }, 'claude-agent');
    expect(await authOn.runtimes.sessionRuntime({ ...minted, factoryProjectId: 'project-2', sessionId: 's1' })).toBe(
      'mastra-code',
    );

    const authOff = await setup({ authOff: true });
    await authOff.sessions.setProjectDefault({ orgId: 'local', projectId: 'project-2' }, 'claude-agent');
    expect(await authOff.runtimes.sessionRuntime({ ...minted, factoryProjectId: 'project-2', sessionId: 's1' })).toBe(
      'claude-agent',
    );
  });

  it('readies a session ahead of its first turn in the background, and only logs a failure', async () => {
    let finish!: () => void;
    const prepareWorkspace = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    const failing = vi.fn(async () => {
      throw new Error('no sandbox');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const base = {
      sessions: { get: vi.fn(), assign: vi.fn(), getProjectDefault: vi.fn() },
      events: new InMemoryEventLog(),
      threadHasMessages: async () => false,
      unscopedDefaults: () => false,
      ownConversation: ['claude-agent'],
    };
    const context = { caller: 'user-1' };

    // Returns at once, before the workspace is ready.
    expect(
      createRunRuntimes({ ...base, prepareWorkspace }).prepare?.({
        sessionId: 's1',
        runtimeId: 'claude-agent',
        requestContext: context as never,
      }),
    ).toBeUndefined();
    await vi.waitFor(() => expect(prepareWorkspace).toHaveBeenCalledWith('s1', context));
    finish();

    createRunRuntimes({ ...base, prepareWorkspace: failing }).prepare?.({
      sessionId: 's2',
      runtimeId: 'claude-agent',
      requestContext: context as never,
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('s2'), expect.any(Error)));
    // Without a preparer there is nothing to do.
    expect(() =>
      createRunRuntimes(base).prepare?.({
        sessionId: 's3',
        runtimeId: 'claude-agent',
        requestContext: context as never,
      }),
    ).not.toThrow();
  });
});
