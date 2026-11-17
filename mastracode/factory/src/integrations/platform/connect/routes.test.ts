import { Hono } from 'hono';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '../../../routes/test-utils.js';
import type { TestAuthUser } from '../../../routes/test-utils.js';
import { PlatformApiClient } from '../api-client.js';
import { buildConnectToolsRoute } from './routes.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function connection(id: string, integrationId: string, status: 'active' | 'needs_reauth' = 'active') {
  return { id, integrationId, status, accountLabel: `${integrationId}-account`, displayName: null };
}

function buildApp(
  user: TestAuthUser | null,
  fetchImpl: typeof fetch,
  options: { authEnabled?: boolean; connectToolsProjectId?: string } = {},
): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  const auth = fakeRouteAuth({ enabled: options.authEnabled ?? true });
  const client = new PlatformApiClient({
    baseUrl: 'https://integrations.example.com',
    accessToken: 'platform-secret',
    fetchImpl,
  });
  const projectId = options.connectToolsProjectId;
  mountApiRoutes(app, [buildConnectToolsRoute(auth, projectId ? { client, projectId } : undefined)]);
  return app;
}

const org1 = (): TestAuthUser => ({ workosId: 'u1', organizationId: 'org1' });

describe('platform connect routes', () => {
  it("lists the project's connections that sessions use, not the organization's or GitHub's", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/v2/projects/proj_1/connections')) {
        return json({
          connections: [
            connection('conn-mcp', 'neon-mcp', 'needs_reauth'),
            connection('conn-asana', 'asana'),
            connection('conn-github', 'github'),
          ],
        });
      }
      if (url.endsWith('/v2/connections')) return json({ connections: [connection('conn-snowflake', 'snowflake')] });
      if (url.endsWith('/v2/integrations')) {
        return json({
          integrations: [
            { id: 'neon-mcp', displayName: 'Neon MCP', logoUrl: 'https://logos.example.com/neon.svg' },
            { id: 'asana', displayName: 'Asana', logoUrl: null },
          ],
        });
      }
      return json({ detail: 'not found' }, 404);
    });
    const app = buildApp({ workosId: 'u1' }, fetchImpl, { connectToolsProjectId: 'proj_1' });

    const response = await app.request('/web/integrations/platform/connect-tools');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projectId: 'proj_1',
      connections: [
        {
          id: 'conn-asana',
          integrationId: 'asana',
          providerName: 'Asana',
          logoUrl: null,
          accountLabel: 'asana-account',
          status: 'active',
        },
        {
          id: 'conn-mcp',
          integrationId: 'neon-mcp',
          providerName: 'Neon MCP',
          logoUrl: 'https://logos.example.com/neon.svg',
          accountLabel: 'neon-mcp-account',
          status: 'needs_reauth',
        },
      ],
    });
  });

  it('still lists the attached connections on a local Factory without auth when the catalog is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input =>
      String(input).endsWith('/v2/projects/proj_1/connections')
        ? json({ connections: [connection('conn-asana', 'asana')] })
        : json({ detail: 'catalog unavailable' }, 503),
    );
    const app = buildApp(null, fetchImpl, { authEnabled: false, connectToolsProjectId: 'proj_1' });

    const response = await app.request('/web/integrations/platform/connect-tools');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projectId: 'proj_1',
      connections: [expect.objectContaining({ id: 'conn-asana', providerName: 'asana', logoUrl: null })],
    });
  });

  it("answers JSON the settings page can read when this Factory's sessions get no Connect tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = buildApp(org1(), fetchImpl);

    const response = await app.request('/web/integrations/platform/connect-tools');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'connect_tools_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a forbidden Platform answer to 403 and other failures to 502', async () => {
    const forbiddenFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ detail: 'Your role has read-only access to this organization' }, 403));
    const forbiddenApp = buildApp(org1(), forbiddenFetch, { connectToolsProjectId: 'proj_1' });
    const forbidden = await forbiddenApp.request('/web/integrations/platform/connect-tools');
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual(expect.objectContaining({ error: 'platform_forbidden' }));

    const failingFetch = vi.fn<typeof fetch>().mockImplementation(async () => json({ detail: 'boom' }, 500));
    const failingApp = buildApp(org1(), failingFetch, { connectToolsProjectId: 'proj_1' });
    const failed = await failingApp.request('/web/integrations/platform/connect-tools');
    expect(failed.status).toBe(502);
  });
});
