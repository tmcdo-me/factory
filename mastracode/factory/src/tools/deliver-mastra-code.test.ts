// fork(claude-agent): slice 5e. Factory's messages reach Mastra Code sessions through its adapter's delivery
// (`deliverMastraCodeNotification`), on a real Mastra Code server driven by a mock model.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LLMock } from '@copilotkit/aimock';
import { createMastraCode } from '@mastra/code-sdk';
import {
  resolveAuthenticatedCredentialTenant,
  setCredentialStoreProvider,
} from '@mastra/code-sdk/agents/credential-resolver';
import { EventEmitterPubSub } from '@mastra/core/events';
import type { NotificationRecord } from '@mastra/core/notifications';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { LibSQLFactoryStorage, LibSQLStore } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { dispatchGithubWebhook, processGithubEvent } from '../integrations/github/webhook.js';
import type { GithubSignalSubscriptionRow, ParsedGithubWebhook } from '../integrations/github/webhook.js';
import { prepareSessionRunContext } from '../integrations/subscription-session.js';
import { resetTenantCredentialResolverForTests } from '../routes/tenant-credentials.js';
import { AgentMessagesStorage } from '../storage/domains/agent-messages/base.js';
import { GithubEventsSeenStorage } from '../storage/domains/github-events/base.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { createFactoryMessagingTools } from './messaging-tools.js';
import type { FactoryToolScope } from './scope.js';

vi.setConfig({ testTimeout: 60_000 });

const ORG = 'org-1';
const OWNER = 'user-owner';
const SENDER = 'user-sender';
const MODEL = 'gpt-5.4-mini';

let directory: string;
let mock: LLMock;
let stops: Array<() => Promise<void> | void>;
/** Whose credentials each model call resolved, by user id. */
let resolved: Array<string | undefined>;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'factory-deliver-'));
  mock = new LLMock({ port: 0 });
  await mock.start();
  vi.stubEnv('OPENAI_BASE_URL', `${mock.url.replace(/\/+$/, '')}/v1`);
  vi.stubEnv('OPENAI_API_KEY', 'process-env-key-must-not-be-used');
  vi.stubEnv('MASTRA_APP_DATA_DIR', path.join(directory, 'app-data'));
  vi.stubEnv('MASTRACODE_DISABLE_UNIX_SOCKET_PUBSUB', '1');
  vi.stubEnv('MASTRACODE_DISABLE_OBSERVATIONAL_MEMORY', '1');
  setCredentialStoreProvider(
    tenant => {
      const key = `key-for-${tenant.userId}`;
      return {
        allowEnvironmentFallback: false,
        reload: () => {},
        get: () => ({ type: 'api_key', key }),
        getStoredApiKey: () => key,
        getApiKey: async () => key,
      };
    },
    async requestContext => {
      const tenant = resolveAuthenticatedCredentialTenant(requestContext);
      resolved.push(tenant?.userId);
      return tenant;
    },
  );
  resolved = [];
  stops = [];
});

afterEach(async () => {
  resetTenantCredentialResolverForTests();
  for (const stop of stops.splice(0).reverse()) await stop();
  await mock.stop();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/** What the model was asked, as text, from request `from` on. */
const askedSince = (from: number) =>
  mock
    .getRequests()
    .slice(from)
    .map(request => JSON.stringify(request));

/**
 * Two people's sessions in one Factory, on Mastra Code: the sender's and the target's. Factory's own
 * records (the reply claims, the GitHub event claims) are on a libSQL file, as Mastra's are, so a test
 * can start the server again over both.
 */
async function twoSessions() {
  const settingsPath = path.join(directory, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      onboarding: { skippedAt: '2026-01-01T00:00:00.000Z', version: 1 },
      models: { activeModelPackId: null, modeDefaults: { build: `openai/${MODEL}`, plan: `openai/${MODEL}` } },
    }),
  );
  mkdirSync(path.join(directory, 'plans'), { recursive: true });
  // The target's turn can be held mid-run on this tool until the test lets it go.
  let entered!: () => void;
  const inTool = new Promise<void>(resolve => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>(resolve => (release = resolve));
  // As the server runs a wake (a notification nobody's request started): as the session row's owner.
  let sessionRows: Parameters<typeof prepareSessionRunContext>[2] | undefined;
  const start = () =>
    createMastraCode({
      prepareWakeRequestContext: async ({
        requestContext,
        threadId,
      }: {
        requestContext: RequestContext;
        threadId: string;
      }) => {
        if (sessionRows) await prepareSessionRunContext(requestContext, threadId, sessionRows);
      },
      cwd: directory,
      homeDir: directory,
      configDir: '.mastracode-test',
      settingsPath,
      storage: new LibSQLStore({ id: 'deliver', url: `file:${path.join(directory, 'mastra.db')}` }),
      storageBackend: 'libsql' as const,
      pubsub: new EventEmitterPubSub(),
      disableMcp: true,
      disableHooks: true,
      disableEnvFile: true,
      disablePlugins: true,
      disableGithubSignals: true,
      createInitialThread: false,
      plansDir: path.join(directory, 'plans'),
      extraTools: {
        wait_here: createTool({
          id: 'wait_here',
          description: 'Wait for the build.',
          inputSchema: z.object({}),
          execute: async () => {
            entered();
            await released;
            return { waited: true };
          },
        }),
      },
    });
  let code = await start();
  stops.push(() => code.controller.shutdown?.());

  const seeded = await createFactoryStorageForTests();
  const sourceControl = seeded.sourceControl.forIntegration('github');
  sessionRows = { sessions: sourceControl.sessions };
  const project = await seeded.projects.create({ orgId: ORG, userId: OWNER, input: { name: 'Mastra' } });
  const installation = await sourceControl.installations.upsert({
    orgId: ORG,
    connectedByUserId: OWNER,
    externalId: '7',
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: ORG,
    input: { installationId: installation.id, externalId: '99', slug: 'octo/hello', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: ORG,
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: OWNER,
  });
  const link = await sourceControl.projectRepositories.link({
    orgId: ORG,
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: OWNER,
    sandboxProvider: 'local',
    sandboxWorkdir: '/sandbox/hello',
  });
  const row = async (userId: string) =>
    sourceControl.sessions.create({
      sessionId: randomUUID(),
      projectRepositoryId: link.id,
      factoryProjectId: project.id,
      orgId: ORG,
      userId,
      branch: `user/${randomUUID()}`,
      baseBranch: 'main',
      visibility: 'org',
    });
  const target = await row(OWNER);
  const sender = await row(SENDER);
  const as = (userId: string) => new RequestContext([['user', { workosId: userId, organizationId: ORG }]]);
  // Each session's thread is its own id, under its own id as resource, as a user session's is.
  const open = (sessionId: string, userId: string) =>
    code.controller.createSession({
      id: sessionId,
      resourceId: sessionId,
      threadId: sessionId,
      ownerId: userId,
      requestContext: as(userId),
    });
  const targetSession = await open(target.sessionId, OWNER);
  await open(sender.sessionId, SENDER);

  const factoryStorage = new LibSQLFactoryStorage({
    id: 'deliver-factory',
    url: `file:${path.join(directory, 'factory.db')}`,
  });
  const agentMessages = factoryStorage.registerDomain(new AgentMessagesStorage());
  const githubEvents = factoryStorage.registerDomain(new GithubEventsSeenStorage());
  await factoryStorage.init();
  stops.push(() => factoryStorage.close());
  // The Claude Agent runtime as the server has it: it runs neither session, and keeps the reply claims.
  const runtime = {
    runs: async () => false,
    isRunning: () => false,
    message: async () => {
      throw new Error('Neither session runs on Claude Agent.');
    },
    deliveries: agentMessages,
  };
  // A run still going when a test ends would reach the next test's mock model: each test waits them out.
  stops.push(async () => {
    for (const sessionId of [target.sessionId, sender.sessionId]) {
      await vi.waitFor(
        async () => expect((await code.controller.getSession(sessionId))?.stream.isActive()).not.toBe(true),
        {
          timeout: 30_000,
        },
      );
    }
  });
  const notifications = async () => (await code.controller.getMastra()!.getStorage()!.getStore('notifications'))!;
  const scope = (session: { sessionId: string }, userId: string): FactoryToolScope => ({
    orgId: ORG,
    factoryProjectId: project.id,
    userId,
    sessionId: session.sessionId,
    resourceId: session.sessionId,
    threadId: session.sessionId,
    kind: 'user',
    interactive: true,
  });
  const tools = (toolScope: FactoryToolScope) =>
    createFactoryMessagingTools(toolScope, {
      sessions: sourceControl.sessions,
      workItems: seeded.workItems,
      auditRecorder: { record: async () => null },
      messaging: async () => ({ controller: code.controller, notifications: await notifications(), runtime }) as never,
    });
  const run = (toolScope: FactoryToolScope, name: string, input: Record<string, unknown>) =>
    tools(toolScope)[name]!.execute(input as never, {} as never) as Promise<Record<string, unknown>>;
  const signal = (message: string, priority: 'low' | 'medium' | 'urgent' = 'medium') =>
    run(scope(sender, SENDER), 'factory_signal_session', {
      sessionId: target.sessionId,
      message,
      priority,
    }) as Promise<{
      delivered: string;
      notificationId: string;
    }>;
  const reply = (inReplyTo: string, message: string) =>
    run(scope(target, OWNER), 'factory_message_origin', { inReplyTo, message });
  const onThread = async (threadId: string): Promise<NotificationRecord[]> =>
    (await notifications()).listNotifications({ threadId, source: 'factory-session' });

  return {
    target,
    sender,
    targetSession,
    as,
    signal,
    reply,
    onThread,
    githubEvents,
    controller: () => code.controller,
    sourceControl,
    hold: { inTool, release },
    /** The server stops, and starts again over the same storage. Nobody has either session open. */
    restart: async () => {
      await code.controller.shutdown?.();
      code = await start();
      stops.push(() => code.controller.shutdown?.());
    },
  };
}

describe('Factory messages to Mastra Code sessions', () => {
  it('wakes an idle session with a message, which it answers once, back to its sender', async () => {
    mock.onMessage(/.*/, { content: 'Noted.' });
    const env = await twoSessions();
    const before = mock.getRequests().length;

    const sent = await env.signal('Is the build green?');

    expect(sent).toMatchObject({ delivered: 'woken', notificationId: expect.any(String) });
    // The target's own run reads it, as its owner.
    await vi.waitFor(() => expect(askedSince(before).join()).toContain('Is the build green?'), { timeout: 30_000 });
    expect(resolved).toContain(OWNER);
    const [record] = await env.onThread(env.target.sessionId);
    expect(record).toMatchObject({
      id: sent.notificationId,
      kind: 'message',
      attributes: { 'from-session': env.sender.sessionId },
    });

    // Two answers at once: one goes, to the sender's thread; the other is refused, as is a later one.
    const answers = await Promise.allSettled([
      env.reply(sent.notificationId, 'Yes, all green.'),
      env.reply(sent.notificationId, 'Green here too.'),
    ]);
    expect(answers.map(answer => answer.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((answers.find(answer => answer.status === 'rejected') as PromiseRejectedResult).reason.message).toBe(
      `You already answered ${sent.notificationId}.`,
    );
    await expect(env.reply(sent.notificationId, 'Still green.')).rejects.toThrow(
      `You already answered ${sent.notificationId}.`,
    );
    const replies = (await env.onThread(env.sender.sessionId)).filter(r => r.kind === 'reply');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.attributes).toMatchObject({
      'in-reply-to': sent.notificationId,
      'from-session': env.target.sessionId,
    });
  });

  it('reaches a running turn mid-run, which reads it before the turn ends', async () => {
    mock.on({ sequenceIndex: 0 }, { toolCalls: [{ id: 'call_wait', name: 'wait_here', arguments: '{}' }] });
    mock.onMessage(/.*/, { content: 'Done.' });
    const env = await twoSessions();
    void env.targetSession.sendMessage({ content: 'Build it.', requestContext: env.as(OWNER) }).catch(() => {});
    await env.hold.inTool;
    const before = mock.getRequests().length;

    const sent = await env.signal('Stop: the release branch is frozen.', 'urgent');

    expect(sent).toMatchObject({ delivered: 'mid-run' });
    env.hold.release();
    // The same turn's next model call carries it: no second run was started for it.
    await vi.waitFor(() => expect(askedSince(before).join()).toContain('the release branch is frozen'), {
      timeout: 30_000,
    });
    await vi.waitFor(() => expect(env.targetSession.stream.isActive()).toBe(false), { timeout: 30_000 });
    expect(askedSince(before).filter(request => request.includes('Build it.')).length).toBeGreaterThan(0);
  });

  it('keeps a message that woke nobody across a restart, where it can still be answered once', async () => {
    mock.onMessage(/.*/, { content: 'Noted.' });
    const env = await twoSessions();
    const before = mock.getRequests().length;

    const sent = await env.signal('No rush: the docs need a look.', 'low');

    // Low priority on an idle session: kept in Mastra's notification store for its dispatcher, not woken.
    expect(sent).toMatchObject({ delivered: 'summarized', notificationId: expect.any(String) });
    expect(askedSince(before)).toEqual([]);

    await env.restart();
    expect(await env.controller().getSession(env.target.sessionId)).toBeUndefined();
    const [kept] = await env.onThread(env.target.sessionId);
    expect(kept).toMatchObject({
      id: sent.notificationId,
      status: 'pending',
      summary: 'No rush: the docs need a look.',
    });
    expect(kept!.summaryAt).toBeInstanceOf(Date);

    // Answered from the restarted server: the sender, not live any more, is opened as its owner and woken.
    await expect(env.reply(sent.notificationId, 'Will do.')).resolves.toMatchObject({ delivered: 'woken' });
    await vi.waitFor(() => expect(askedSince(before).join()).toContain('Will do.'), { timeout: 30_000 });
    expect(resolved).toContain(SENDER);
    await expect(env.reply(sent.notificationId, 'Again.')).rejects.toThrow(
      `You already answered ${sent.notificationId}.`,
    );
  });

  it('tells a session about one GitHub event once, whether it came by webhook or by poll', async () => {
    mock.onMessage(/.*/, { content: 'Looking at the review.' });
    const env = await twoSessions();
    const subscription: GithubSignalSubscriptionRow = {
      id: 'subscription-1',
      orgId: ORG,
      targetKey: 'change-request:7:99:34',
      sessionId: env.target.sessionId,
      resourceId: env.target.sessionId,
      threadId: env.target.sessionId,
      sessionScope: null,
      status: 'open',
      data: {
        installationExternalId: '7',
        projectRepositoryId: env.target.projectRepositoryId!,
        repositoryExternalId: '99',
        repositorySlug: 'octo/hello',
        changeRequestId: '34',
        ownerId: OWNER,
        source: 'explicit-tool',
        subscribedByUserId: OWNER,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const review = (deliveryId: string): ParsedGithubWebhook => ({
      event: 'pull_request_review',
      deliveryId,
      payload: {
        action: 'submitted',
        installation: { id: 7 },
        repository: { id: 99, full_name: 'octo/hello' },
        sender: { login: 'ada' },
        pull_request: { number: 34 },
        review: { id: 4242, state: 'changes_requested', body: 'Please add a test.' },
      },
    });
    const deliver = (event: ParsedGithubWebhook) =>
      processGithubEvent(event, {
        claims: env.githubEvents,
        dispatch: async parsed => {
          const result = await dispatchGithubWebhook(parsed, {
            controller: env.controller(),
            github: { sourceControlStorage: env.sourceControl } as never,
            listSubscriptions: async () => [subscription],
            retireSubscription: async () => {},
            isAuthorizedSender: async () => true,
          });
          return { failed: result.failed };
        },
      });

    // The webhook's delivery, then the active pull request poll's view of the same review.
    await expect(deliver(review('webhook-delivery'))).resolves.toBe('handled');
    await vi.waitFor(() => expect(env.targetSession.stream.isActive()).toBe(false), { timeout: 30_000 });
    await expect(deliver(review('poll:github:99:pull-request:34:review:4242'))).resolves.toBe('duplicate');

    const told = (await (await env
      .controller()
      .getMastra()!
      .getStorage()!
      .getStore('notifications'))!.listNotifications({
      threadId: env.target.sessionId,
      source: 'github',
    })) as NotificationRecord[];
    expect(told).toHaveLength(1);
    expect(mock.getRequests().filter(request => JSON.stringify(request).includes('ada')).length).toBeGreaterThan(0);
  });
});
