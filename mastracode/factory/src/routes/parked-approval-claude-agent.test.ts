// fork(claude-agent): the card's and the inbox's approve button, on a Claude Agent session.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeApprovals } from '../rules/runtime-sessions.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { buildSourceControlSessionRoutes } from './source-control-sessions.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const SESSION = 'claude-session-1';

async function setup(runs: boolean) {
  const seed = await createFactoryStorageForTests();
  const sourceControl = seed.sourceControl.forIntegration('github');
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Project' } });
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: 'installation-1',
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '1', slug: 'acme/app', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  const projectRepository = await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace/app',
  });
  await sourceControl.sessions.create({
    sessionId: SESSION,
    projectRepositoryId: projectRepository.id,
    orgId: 'org-1',
    userId: 'user-1',
    branch: 'factory/plan-1',
    baseBranch: 'main',
    visibility: 'org',
  });
  const getSession = vi.fn(async () => null);
  const answer = vi.fn<RuntimeApprovals['answer']>(async () => 'answered');
  const runtimeSessions = {
    runs: vi.fn(async () => runs),
    isRunning: () => false,
    message: vi.fn(),
    approvals: { waiting: async () => [{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }], answer },
  };
  const audit = { record: vi.fn() };
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('factoryAuthUser' as never, { workosId: 'user-1', organizationId: 'org-1' } as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    buildSourceControlSessionRoutes({
      auth: fakeRouteAuth(),
      sourceControls: [sourceControl],
      projects: seed.projects,
      memorySettings: { get: async () => null } as never,
      controller: { getSession } as never,
      audit: audit as never,
      runtimeSessions,
    }),
  );
  const post = (body: unknown) =>
    app.request(`/web/user-sessions/${SESSION}/parked-approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post, getSession, answer, audit };
}

describe('answering a Claude Agent session from its card', () => {
  it("answers the plan it waits on through its runtime, as the session's owner, and audits it", async () => {
    const { post, getSession, answer, audit } = await setup(true);

    const response = await post({ decision: 'decline', reason: 'Too broad.' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      answered: 'decline',
      sessionId: SESSION,
      toolCallId: 'toolu_plan',
      toolName: 'submit_plan',
    });
    expect(answer).toHaveBeenCalledWith(
      SESSION,
      'toolu_plan',
      { decision: 'decline', reason: 'Too broad.', answeredBy: 'user-1' },
      expect.anything(),
    );
    expect(getSession).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'factory.run.dismissed',
        metadata: expect.objectContaining({ toolCallId: 'toolu_plan', cause: 'web' }),
      }),
    );
  });

  it('leaves a Mastra Code session to the controller', async () => {
    const { post, getSession, answer } = await setup(false);
    const response = await post({ decision: 'approve' });
    expect(response.status).toBe(409);
    expect(getSession).toHaveBeenCalledWith(SESSION);
    expect(answer).not.toHaveBeenCalled();
  });
});
