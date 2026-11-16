// fork(claude-agent)
import { InMemoryEventLog } from '@factory/agent-runtime';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { ClaudeAgentConcurrency } from '../session/claude-agent-concurrency.js';
import { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';
import { buildAgentRuntimeRoutes } from './agent-runtimes.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const alice = { workosId: 'user-alice', organizationId: 'org-1' };

async function setup(
  options: {
    user?: { workosId: string; organizationId?: string };
    authEnabled?: boolean;
    historyPredatesLog?: (sessionId: string) => Promise<boolean>;
    env?: Record<string, string>;
    /** Whether the caller administers their organization; members by default are. */
    admin?: boolean;
  } = { user: alice },
) {
  const storage = new LibSQLFactoryStorage({ id: 'agent-runtimes-test', url: ':memory:' });
  const sessions = storage.registerDomain(new AgentSessionsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  const concurrency = new ClaudeAgentConcurrency({ settings: sessions, env: options.env ?? {} });
  await concurrency.start();
  onTestFinished(() => concurrency.stop());
  const log = new InMemoryEventLog();
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (options.user) c.set('factoryAuthUser' as never, options.user as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    buildAgentRuntimeRoutes({
      auth: fakeRouteAuth({
        enabled: options.authEnabled,
        isOrganizationAdmin: async () => options.admin ?? true,
      }),
      sessions,
      events: log,
      projects: { get: async ({ orgId, id }) => (orgId === 'org-1' && id === 'p1' ? { id } : null) },
      historyPredatesLog: options.historyPredatesLog,
      claudeAgentConcurrency: concurrency,
    }),
  );
  return { app, sessions, log, concurrency };
}

const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('agent runtime routes', () => {
  it('lists the runtimes with Claude Agent models', async () => {
    const { app } = await setup();
    const body = (await (await app.request('/web/factory/runtimes')).json()) as {
      runtimes: { id: string; label: string; models?: { id: string }[] }[];
      defaultRuntimeId: string;
    };
    expect(body.defaultRuntimeId).toBe('mastra-code');
    expect(body.runtimes.map(r => [r.id, r.label])).toEqual([
      ['mastra-code', 'Mastra Code'],
      ['claude-agent', 'Claude Agent'],
    ]);
    expect(body.runtimes[1]!.models?.map(m => m.id)).toContain('claude-opus-5-5');
  });

  it('chooses a session runtime before it starts, and not after', async () => {
    const { app, log } = await setup();
    expect(await (await app.request('/web/factory/sessions/s1/runtime')).json()).toEqual({
      runtimeId: 'mastra-code',
      transcript: 'factory',
    });

    expect(
      (
        await app.request(
          '/web/factory/sessions/s1/runtime',
          put({ runtimeId: 'claude-agent', modelId: 'claude-opus-5-5' }),
        )
      ).status,
    ).toBe(200);
    expect(await (await app.request('/web/factory/sessions/s1/runtime')).json()).toEqual({
      runtimeId: 'claude-agent',
      modelId: 'claude-opus-5-5',
      transcript: 'factory',
    });
    const fixed = await app.request('/web/factory/sessions/s1/runtime', put({ runtimeId: 'mastra-code' }));
    expect(fixed.status).toBe(409);
    expect(await fixed.json()).toMatchObject({ reason: 'runtime_fixed' });

    await log.append('s2', [{ type: 'run.started', runId: 'r' }]);
    const started = await app.request('/web/factory/sessions/s2/runtime', put({ runtimeId: 'claude-agent' }));
    expect(started.status).toBe(409);
    expect(await started.json()).toMatchObject({ reason: 'session_started' });

    expect((await app.request('/web/factory/sessions/s3/runtime', put({ runtimeId: 'pi' }))).status).toBe(400);
  });

  it('draws a Mastra Code session from Mastra memory only when its conversation began before its event log', async () => {
    const legacy = new Set(['old']);
    const { app, sessions } = await setup({
      user: alice,
      historyPredatesLog: async sessionId => {
        if (sessionId === 'unreadable') throw new Error('storage down');
        return legacy.has(sessionId);
      },
    });
    const transcript = async (sessionId: string) =>
      ((await (await app.request(`/web/factory/sessions/${sessionId}/runtime`)).json()) as { transcript?: string })
        .transcript;

    expect(await transcript('old')).toBe('mastra');
    expect(await transcript('new')).toBe('factory');
    // A check that fails answers 503 so the UI asks again: it never guesses where the history is.
    const unreadable = await app.request('/web/factory/sessions/unreadable/runtime');
    expect(unreadable.status).toBe(503);
    expect(await unreadable.json()).toMatchObject({ error: 'unavailable' });
    // Claude Agent sessions only ever have the event log.
    legacy.add('claude');
    await sessions.assign('claude', 'claude-agent', 'claude-opus-5-5');
    expect(await transcript('claude')).toBe('factory');
  });

  it("reads and sets a project's default runtime within the caller's organization", async () => {
    const { app } = await setup();
    expect(await (await app.request('/web/factory/projects/p1/runtime')).json()).toEqual({ runtimeId: 'mastra-code' });
    expect((await app.request('/web/factory/projects/p1/runtime', put({ runtimeId: 'claude-agent' }))).status).toBe(
      200,
    );
    expect(await (await app.request('/web/factory/projects/p1/runtime')).json()).toEqual({ runtimeId: 'claude-agent' });
    expect((await app.request('/web/factory/projects/other/runtime')).status).toBe(404);
    expect((await app.request('/web/factory/projects/other/runtime', put({ runtimeId: 'claude-agent' }))).status).toBe(
      404,
    );
  });

  it('needs a signed-in user when auth is on', async () => {
    const { app } = await setup({});
    expect((await app.request('/web/factory/runtimes')).status).toBe(401);
    expect((await app.request('/web/factory/projects/p1/runtime')).status).toBe(401);
  });

  it("refuses a caller with no organization: nobody's project is theirs to set", async () => {
    const { app, sessions } = await setup({ user: { workosId: 'user-mallory' } });
    expect((await app.request('/web/factory/projects/p1/runtime')).status).toBe(403);
    expect((await app.request('/web/factory/projects/p1/runtime', put({ runtimeId: 'claude-agent' }))).status).toBe(
      403,
    );
    // Not filed under the unscoped `local` org either, where a run could read it.
    expect(await sessions.getProjectDefault({ orgId: 'local', projectId: 'p1' })).toBeUndefined();
  });

  it('files defaults under the unscoped org when auth is off', async () => {
    const { app, sessions } = await setup({ authEnabled: false });
    expect((await app.request('/web/factory/projects/p9/runtime', put({ runtimeId: 'claude-agent' }))).status).toBe(
      200,
    );
    expect(await sessions.getProjectDefault({ orgId: 'local', projectId: 'p9' })).toBe('claude-agent');
  });

  // fork(claude-agent): spec slice 13.
  describe('Claude Agent concurrency', () => {
    const path = '/web/factory/runtimes/claude-agent/concurrency';

    it("starts from the server's default, and lets a waiting turn go once Settings raise the cap", async () => {
      const { app, concurrency } = await setup({ user: alice, env: { FACTORY_CLAUDE_AGENT_MAX_CONCURRENT: '1' } });
      expect(await (await app.request(path)).json()).toEqual({
        maxConcurrent: null,
        defaultMaxConcurrent: 1,
        effective: 1,
        running: 0,
        waiting: 0,
      });
      // One session runs a turn; a second one's turn waits for a slot.
      const first = concurrency.limiter.slots('s1').take({ runId: 'r1' });
      const second = concurrency.limiter.slots('s2').take({ runId: 'r2' });
      expect(second.waiting).toBeDefined();
      let started = false;
      void second.ready.then(() => (started = true));
      expect(await (await app.request(path)).json()).toMatchObject({ running: 1, waiting: 1 });

      const raised = await app.request(path, put({ maxConcurrent: 2 }));
      expect(raised.status).toBe(200);
      await expect.poll(() => started).toBe(true);
      expect(await raised.json()).toMatchObject({ maxConcurrent: 2, effective: 2, running: 2, waiting: 0 });

      // 0 is no limit; null goes back to the server's default.
      expect(await (await app.request(path, put({ maxConcurrent: 0 }))).json()).toMatchObject({ effective: null });
      expect(await (await app.request(path, put({ maxConcurrent: null }))).json()).toMatchObject({
        maxConcurrent: null,
        effective: 1,
      });
      first.release();
      second.release();
    });

    it('keeps the setting for the next server start, and for another process sharing the database', async () => {
      const { app, sessions } = await setup();
      expect(await (await app.request(path)).json()).toMatchObject({ defaultMaxConcurrent: null, effective: null });
      await app.request(path, put({ maxConcurrent: 3 }));
      const restarted = new ClaudeAgentConcurrency({ settings: sessions, env: {} });
      await restarted.reload();
      expect(restarted.state()).toMatchObject({ maxConcurrent: 3, effective: 3 });
    });

    it('lets only an organization administrator see or change it', async () => {
      const member = await setup({ user: alice, admin: false });
      const read = await member.app.request(path);
      expect(read.status).toBe(403);
      expect(await read.json()).toMatchObject({ error: 'organization_admin_required' });
      expect((await member.app.request(path, put({ maxConcurrent: 1 }))).status).toBe(403);
      expect(member.concurrency.state().maxConcurrent).toBeNull();
    });

    it('refuses a cap that is not a whole number in range, and callers who are not signed in', async () => {
      const { app } = await setup();
      expect((await app.request(path, put({ maxConcurrent: -1 }))).status).toBe(400);
      expect((await app.request(path, put({ maxConcurrent: 1.5 }))).status).toBe(400);
      expect((await app.request(path, put({ maxConcurrent: 65 }))).status).toBe(400);
      const anonymous = await setup({ authEnabled: true });
      expect((await anonymous.app.request(path)).status).toBe(401);
      const noOrg = await setup({ authEnabled: true, user: { workosId: 'user-bob' } });
      expect((await noOrg.app.request(path, put({ maxConcurrent: 1 }))).status).toBe(403);
    });
  });
});
