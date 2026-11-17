import { stateSchema } from '@mastra/code-sdk/schema';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const prime = vi.fn<(context: unknown) => Promise<void>>().mockResolvedValue(undefined);
vi.mock('../routes/tenant-credentials.js', () => ({
  primeTenantCredentialsForRequestContext: (context: unknown) => prime(context),
}));

import { resolveSubscriptionSession } from './mastra-code-subscription-sessions.js';
import type { SubscriptionSessionRow } from './subscription-session.js';

function row(overrides: Partial<SubscriptionSessionRow['data']> = {}, orgId = 'org-1'): SubscriptionSessionRow {
  return {
    id: 'sub-1',
    orgId,
    targetKey: 'change-request:x',
    sessionId: 'session-1',
    resourceId: 'factory-1',
    threadId: 'thread-1',
    sessionScope: '',
    status: 'open',
    data: { projectRepositoryId: 'repo-1', subscribedByUserId: 'user-1', ...overrides },
    createdAt: new Date('2026-09-21T00:00:00Z'),
    updatedAt: new Date('2026-09-21T00:00:00Z'),
  };
}

describe('resolveSubscriptionSession', () => {
  it.each([false, true])('restores the subscribed thread independently of the Factory row (cold=%s)', async cold => {
    const controller = new AgentController<MastraCodeState>({
      id: 'code',
      stateSchema,
      storage: new InMemoryStore({ id: 'subscription-single-thread-host' }),
      workspace: new Workspace({ name: 'test-workspace', skills: ['/tmp/test-skills'] }),
      modes: [
        {
          id: 'build',
          name: 'Build',
          default: true,
          agent: new Agent({
            id: 'test-agent',
            name: 'Test agent',
            instructions: 'Test subscription addressing.',
            model: { id: 'openai/gpt-5.5' },
          }),
        },
      ],
    });
    await controller.init();
    const original = await controller.createSession({
      id: 'session-1',
      ownerId: 'user-1',
      resourceId: 'session-1',
      threadId: 'thread-1',
    });
    onTestFinished(async () => {
      await controller.deleteSession({ sessionId: 'session-1' });
    });
    if (cold) await controller.deleteSession({ sessionId: 'session-1' });
    else {
      await original.thread.create();
      expect(original.thread.getId()).not.toBe('thread-1');
    }
    const queryThread = vi.spyOn(controller, 'queryThreadById');
    const getBySessionId = vi.fn(async () => ({ userId: 'user-1', orgId: 'org-1' }));
    const session = await resolveSubscriptionSession(controller, row(), {
      label: 'Test',
      sourceControl: { sessions: { getBySessionId } },
    });
    expect(queryThread).toHaveBeenCalledWith({ threadId: 'thread-1' });
    expect(getBySessionId).toHaveBeenCalledWith('session-1');
    expect(getBySessionId).not.toHaveBeenCalledWith('thread-1');
    expect(getBySessionId).not.toHaveBeenCalledWith('factory-1');
    expect(session?.identity.getId()).toBe('session-1');
    expect(session?.identity.getResourceId()).toBe('session-1');
    expect(session?.thread.getId()).toBe('thread-1');
    expect(session?.state.get()).toMatchObject({ factoryOrgId: 'org-1' });
    if (!cold) expect(session).toBe(original);
  });
});

