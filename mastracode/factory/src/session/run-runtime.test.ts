// fork(claude-agent)
import { InMemoryEventLog } from '@factory/agent-runtime';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';
import { createRunRuntimes } from './run-runtime.js';

const scope = { orgId: 'org-1', factoryProjectId: 'project-1' };

async function setup() {
  const storage = new LibSQLFactoryStorage({ id: 'run-runtime-test', url: ':memory:' });
  const sessions = storage.registerDomain(new AgentSessionsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  const events = new InMemoryEventLog();
  const runtimes = createRunRuntimes({ sessions, events, ownConversation: ['claude-agent'] });
  return { sessions, events, runtimes };
}

describe('createRunRuntimes', () => {
  it("gives a session that never ran its project's default, and records it", async () => {
    const { sessions, runtimes } = await setup();
    await sessions.setProjectDefault({ orgId: 'org-1', projectId: 'project-1' }, 'claude-agent');

    expect(await runtimes.sessionRuntime({ ...scope, sessionId: 's1' })).toBe('claude-agent');
    expect(await sessions.get('s1')).toMatchObject({ runtimeId: 'claude-agent' });
    expect(runtimes.ownsConversation('claude-agent')).toBe(true);
    expect(runtimes.ownsConversation('mastra-code')).toBe(false);
  });

  it('keeps a session on the runtime it has, whatever the default says now', async () => {
    const { sessions, runtimes } = await setup();
    await sessions.assign('s1', 'claude-agent');
    expect(await runtimes.sessionRuntime({ ...scope, sessionId: 's1' })).toBe('claude-agent');

    await sessions.setProjectDefault({ orgId: 'org-1', projectId: 'project-1' }, 'claude-agent');
    const events = new InMemoryEventLog();
    await events.append('s2', [{ type: 'run.started', runId: 'r1' }]);
    const withHistory = createRunRuntimes({ sessions, events, ownConversation: ['claude-agent'] });
    // A session that already ran without a record ran on Mastra Code, and stays there.
    expect(await withHistory.sessionRuntime({ ...scope, sessionId: 's2' })).toBe('mastra-code');
    expect(await sessions.get('s2')).toBeUndefined();
  });

  it('runs on Mastra Code when the project has no default, recording nothing', async () => {
    const { sessions, runtimes } = await setup();
    expect(await runtimes.sessionRuntime({ ...scope, sessionId: 's1' })).toBe('mastra-code');
    expect(await sessions.get('s1')).toBeUndefined();
  });

  it('reads a default saved without an organization (auth off, personal accounts)', async () => {
    const { sessions, runtimes } = await setup();
    await sessions.setProjectDefault({ orgId: 'local', projectId: 'project-1' }, 'claude-agent');
    expect(await runtimes.sessionRuntime({ ...scope, sessionId: 's1' })).toBe('claude-agent');
  });
});
