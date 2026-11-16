// fork(claude-agent)
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentSessionsStorage } from './base.js';

async function setup() {
  const storage = new LibSQLFactoryStorage({ id: 'agent-sessions-test', url: ':memory:' });
  const sessions = storage.registerDomain(new AgentSessionsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return sessions;
}

describe('AgentSessionsStorage', () => {
  it('assigns a runtime once, and refuses to change it', async () => {
    const sessions = await setup();
    expect(await sessions.get('s1')).toBeUndefined();

    expect(await sessions.assign('s1', 'claude-agent', 'claude-opus-5-5')).toBe(true);
    expect(await sessions.get('s1')).toMatchObject({ runtimeId: 'claude-agent', modelId: 'claude-opus-5-5' });

    expect(await sessions.assign('s1', 'claude-agent', 'claude-sonnet-5-5')).toBe(true); // same runtime: model updates
    expect(await sessions.get('s1')).toMatchObject({ modelId: 'claude-sonnet-5-5' });
    expect(await sessions.assign('s1', 'mastra-code')).toBe(false);
    expect(await sessions.get('s1')).toMatchObject({ runtimeId: 'claude-agent' });
  });

  it('keeps resume state and the model', async () => {
    const sessions = await setup();
    await sessions.assign('s1', 'claude-agent');
    await sessions.setRuntimeState('s1', { claudeSessionId: 'abc' });
    await sessions.setModel('s1', 'claude-haiku-5-5');
    expect(await sessions.get('s1')).toMatchObject({
      runtimeState: { claudeSessionId: 'abc' },
      modelId: 'claude-haiku-5-5',
    });
  });

  it('stores one default runtime per project', async () => {
    const sessions = await setup();
    const scope = { orgId: 'o', projectId: 'p' };
    expect(await sessions.getProjectDefault(scope)).toBeUndefined();
    await sessions.setProjectDefault(scope, 'claude-agent');
    await sessions.setProjectDefault(scope, 'mastra-code');
    expect(await sessions.getProjectDefault(scope)).toBe('mastra-code');
    expect(await sessions.getProjectDefault({ orgId: 'o', projectId: 'other' })).toBeUndefined();
  });
});
