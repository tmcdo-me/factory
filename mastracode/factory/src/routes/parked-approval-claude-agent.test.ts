// fork(claude-agent): the card's and the inbox's approve button, on a Claude Agent session.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeApprovals, RuntimeQuestions } from '../rules/runtime-sessions.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { buildSourceControlSessionRoutes } from './source-control-sessions.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const SESSION = 'claude-session-1';

async function setup(
  runs: boolean,
  { viewer = 'user-1', follows = false }: { viewer?: string; follows?: boolean } = {},
) {
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
  // A session of the viewer's own that follows the card, when they follow it.
  await sourceControl.sessions.create({
    sessionId: 'follower-session',
    projectRepositoryId: projectRepository.id,
    orgId: 'org-1',
    userId: 'user-2',
    branch: 'user/session-follower',
    baseBranch: 'main',
    visibility: 'org',
  });
  const workItems = {
    clearSessionReferences: async () => 0,
    hasRunBindingForSession: async () => true,
    findActiveRunBindingForSession: async () => ({ workItemId: 'item-1' }) as never,
    get: async () => ({ id: 'item-1', createdBy: 'user-1' }) as never,
    listWorkItemSubscribers: async () => (follows ? [{ sessionId: 'follower-session' }] : []) as never,
  };
  const getSession = vi.fn(async () => null);
  const answer = vi.fn<RuntimeApprovals['answer']>(async () => 'answered');
  const answerQuestion = vi.fn<RuntimeQuestions['answer']>(async () => 'answered');
  const runtimeSessions = {
    runs: vi.fn(async () => runs),
    isRunning: () => false,
    message: vi.fn(),
    approvals: { waiting: async () => [{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }], answer },
    questions: { waiting: async () => [{ toolCallId: 'toolu_ask', toolName: 'ask_user' }], answer: answerQuestion },
  };
  const audit = { record: vi.fn() };
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('factoryAuthUser' as never, { workosId: viewer, organizationId: 'org-1' } as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    buildSourceControlSessionRoutes({
      // Nobody here is an org admin: only the owner and the card's followers may answer.
      auth: fakeRouteAuth({ isOrganizationAdmin: async () => false }),
      workItems,
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
  const postQuestion = (body: unknown) =>
    app.request(`/web/user-sessions/${SESSION}/parked-question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post, postQuestion, getSession, answer, answerQuestion, audit };
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

  it('refuses someone who neither owns the session nor follows its card, answering nothing', async () => {
    const { post, answer } = await setup(true, { viewer: 'user-2' });
    const response = await post({ decision: 'approve' });
    expect(response.status).toBe(403);
    expect(answer).not.toHaveBeenCalled();
  });

  it('lets a follower of its card answer, recorded as theirs', async () => {
    const { post, answer } = await setup(true, { viewer: 'user-2', follows: true });
    expect((await post({ decision: 'approve' })).status).toBe(200);
    expect(answer).toHaveBeenCalledWith(
      SESSION,
      'toolu_plan',
      { decision: 'approve', answeredBy: 'user-2' },
      expect.anything(),
    );
    // The run carries on as the session's owner, whoever answered.
    const requestContext = answer.mock.calls[0]![3] as { get(key: string): unknown };
    expect(requestContext.get('user')).toEqual({ workosId: 'user-1', organizationId: 'org-1' });
  });
});

describe("answering a Claude Agent session's question from outside it", () => {
  it("answers through its runtime as the session's owner, recorded as the follower's, and audits it", async () => {
    const { postQuestion, answerQuestion, answer, getSession, audit } = await setup(true, {
      viewer: 'user-2',
      follows: true,
    });

    const response = await postQuestion({ answer: ['Postgres', 'SQLite'] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      answered: true,
      sessionId: SESSION,
      toolCallId: 'toolu_ask',
      toolName: 'ask_user',
    });
    expect(answerQuestion).toHaveBeenCalledWith(
      SESSION,
      { toolCallId: 'toolu_ask' },
      { answer: ['Postgres', 'SQLite'], answeredBy: 'user-2' },
      expect.anything(),
    );
    const requestContext = answerQuestion.mock.calls[0]![3] as { get(key: string): unknown };
    expect(requestContext.get('user')).toEqual({ workosId: 'user-1', organizationId: 'org-1' });
    expect(answer).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'factory.run.answered', actorId: 'user-2' }),
    );
  });

  it('refuses someone who neither owns the session nor follows its card, and an empty answer', async () => {
    const stranger = await setup(true, { viewer: 'user-2' });
    expect((await stranger.postQuestion({ answer: 'Postgres' })).status).toBe(403);
    expect(stranger.answerQuestion).not.toHaveBeenCalled();

    const owner = await setup(true);
    expect((await owner.postQuestion({ answer: '  ' })).status).toBe(400);
    expect(owner.answerQuestion).not.toHaveBeenCalled();
  });

  it('says so when the question was already answered', async () => {
    const { postQuestion, answerQuestion } = await setup(true);
    answerQuestion.mockResolvedValueOnce('not_pending');
    const response = await postQuestion({ answer: 'Postgres', toolCallId: 'toolu_ask' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'That call was already answered: someone else got there first.',
    });
  });
});
