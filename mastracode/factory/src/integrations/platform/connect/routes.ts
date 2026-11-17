/**
 * The Mastra `apiRoute` that lists the Platform project connections whose
 * Mastra Connect tools sessions get. The browser cannot talk to the
 * integrations service itself — it has no Platform session — so the route
 * reads them server-side with the deploy's machine credentials
 * (`MASTRA_PLATFORM_ACCESS_TOKEN`/`MASTRA_PLATFORM_SECRET_KEY`).
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import { loose } from '../../../routes/route.js';
import type { RouteAuth } from '../../../routes/route.js';
import type { PlatformApiClient } from '../api-client.js';
import { PlatformApiError } from '../api-client.js';
import { offersSessionTools } from './session-tools.js';

interface ProjectConnectionRow {
  id: string;
  integrationId: string;
  status: string;
  accountLabel?: string | null;
}

interface CatalogEntry {
  id: string;
  displayName?: string | null;
  logoUrl?: string | null;
}

export interface ConnectToolsSource {
  client: PlatformApiClient;
  projectId: string;
}

function platformError(c: Context, err: unknown) {
  if (err instanceof PlatformApiError) {
    if (err.status === 409) {
      return c.json({ error: 'session_pending', message: err.message }, 409);
    }
    if (err.status === 403) {
      return c.json({ error: 'platform_forbidden', message: err.message }, 403);
    }
  }
  return c.json({ error: 'platform_request_failed', message: err instanceof Error ? err.message : String(err) }, 502);
}

export function buildConnectToolsRoute(auth: RouteAuth, source: ConnectToolsSource | undefined): ApiRoute {
  return registerApiRoute('/web/integrations/platform/connect-tools', {
    method: 'GET',
    requiresAuth: false,
    handler: async rawContext => {
      const c = loose(rawContext);
      if (!source) {
        return c.json(
          { error: 'connect_tools_off', message: "This Factory's sessions don't get Mastra Connect tools." },
          404,
        );
      }
      if (auth.enabled()) {
        await auth.ensureUser(c);
        if (!auth.tenant(c)) return c.json({ error: 'unauthorized' }, 401);
      }
      const { client, projectId } = source;
      try {
        const [listed, catalog] = await Promise.all([
          client.request<{ connections: ProjectConnectionRow[] }>(
            'GET',
            `/v2/projects/${encodeURIComponent(projectId)}/connections`,
          ),
          client.request<{ integrations: CatalogEntry[] }>('GET', '/v2/integrations').catch((error: unknown) => {
            console.warn(
              `MastraFactory: listing connections without provider names; the Platform catalog failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { integrations: [] };
          }),
        ]);
        const entries = new Map(catalog.integrations.map(entry => [entry.id, entry]));
        const connections = listed.connections
          .filter(connection => offersSessionTools(connection.integrationId))
          .map(connection => {
            const entry = entries.get(connection.integrationId);
            return {
              id: connection.id,
              integrationId: connection.integrationId,
              providerName: entry?.displayName ?? connection.integrationId,
              logoUrl: entry?.logoUrl ?? null,
              accountLabel: connection.accountLabel ?? null,
              status: connection.status,
            };
          })
          .sort((a, b) => a.providerName.localeCompare(b.providerName));
        return c.json({ projectId, connections });
      } catch (err) {
        return platformError(c, err);
      }
    },
  });
}
