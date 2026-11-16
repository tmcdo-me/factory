// fork(claude-agent)
import { InMemoryEventLog } from '@factory/agent-runtime';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';
import { buildAgentRuntimeRoutes } from './agent-runtimes.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const alice = { workosId: 'user-alice', organizationId: 'org-1' };

async function setup(
  options: {
    user?: { workosId: string; organizationId?: string };
    authEnabled?: boolean;
    historyPredatesLog?: (sessionId: string) => Promise<boolean>;
  } = { user: alice },
) {
  const storage = new LibSQLFactoryStorage({ id: 'agent-runtimes-test', url: ':memory:' });
  const sessions = storage.registerDomain(new AgentSessionsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  const log = new InMemoryEventLog();
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (options.user) c.set('factoryAuthUser' as never, options.user as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    buildAgentRuntimeRoutes({
      auth: fakeRouteAuth({ enabled: options.authEnabled }),
      sessions,
      events: log,
      projects: { get: async ({ orgId, id }) => (orgId === 'org-1' && id === 'p1' ? { id } : null) },
      historyPredatesLog: options.historyPredatesLog,
    }),
  );
  return { app, sessions, log };
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
});
