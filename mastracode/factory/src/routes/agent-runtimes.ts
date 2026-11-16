// fork(claude-agent): which agent runtimes exist, which one a session runs on, and each project's default.
/**
 * - `GET  /web/factory/runtimes` — the runtimes this deployment offers (Claude Agent with its models).
 * - `GET  /web/factory/sessions/:sessionId/runtime` — the session's runtime (default when unset).
 * - `PUT  /web/factory/sessions/:sessionId/runtime` — choose it, before the session's first message;
 *   owner-only (`createSessionAccessGuard`).
 * - `GET|PUT /web/factory/projects/:projectId/runtime` — the project's default for new sessions.
 */
import type { EventLog } from '@factory/agent-runtime';
import { CLAUDE_AGENT_MODELS, CLAUDE_AGENT_RUNTIME_ID } from '@factory/runtime-claude-agent';
import { MASTRA_CODE_RUNTIME_ID } from '@factory/runtime-mastra-code';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';

import type { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';
import { loose } from './route.js';
import type { RouteAuth } from './route.js';

export const DEFAULT_RUNTIME_ID = MASTRA_CODE_RUNTIME_ID;

export const RUNTIME_CATALOG = [
  // Mastra Code's models come from the existing model catalog (`/web/config/models`).
  { id: MASTRA_CODE_RUNTIME_ID, label: 'Mastra Code' },
  { id: CLAUDE_AGENT_RUNTIME_ID, label: 'Claude Agent', models: CLAUDE_AGENT_MODELS },
] as const;

const RUNTIME_IDS = RUNTIME_CATALOG.map(runtime => runtime.id) as [string, ...string[]];

const sessionRuntimeBody = z.object({ runtimeId: z.enum(RUNTIME_IDS), modelId: z.string().min(1).optional() });
const projectRuntimeBody = z.object({ runtimeId: z.enum(RUNTIME_IDS) });

export interface AgentRuntimeRoutesDependencies {
  auth: RouteAuth;
  sessions: Pick<AgentSessionsStorage, 'get' | 'assign' | 'getProjectDefault' | 'setProjectDefault'>;
  events: Pick<EventLog, 'list'>;
  projects: { get(args: { orgId: string; id: string }): Promise<unknown> };
}

export function buildAgentRuntimeRoutes({
  auth,
  sessions,
  events,
  projects,
}: AgentRuntimeRoutesDependencies): ApiRoute[] {
  const viewer = async (c: ReturnType<typeof loose>) => {
    if (!auth.enabled()) return { ok: true as const, orgId: undefined };
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    return tenant ? { ok: true as const, orgId: tenant.orgId } : { ok: false as const };
  };

  /** The caller's organization owns the project (with auth off, any project id is accepted). */
  const projectScope = async (c: ReturnType<typeof loose>) => {
    const who = await viewer(c);
    if (!who.ok) return { status: 401 as const };
    const projectId = c.req.param('projectId');
    if (!projectId) return { status: 404 as const };
    const orgId = who.orgId ?? 'local';
    if (who.orgId && !(await projects.get({ orgId, id: projectId }))) return { status: 404 as const };
    return { status: 200 as const, scope: { orgId, projectId } };
  };

  return [
    registerApiRoute('/web/factory/runtimes', {
      method: 'GET',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        if (!(await viewer(c)).ok) return c.json({ error: 'unauthorized' }, 401);
        return c.json({ runtimes: RUNTIME_CATALOG, defaultRuntimeId: DEFAULT_RUNTIME_ID });
      },
    }),
    registerApiRoute('/web/factory/sessions/:sessionId/runtime', {
      method: 'GET',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        if (!(await viewer(c)).ok) return c.json({ error: 'unauthorized' }, 401);
        const record = await sessions.get(c.req.param('sessionId')!);
        return c.json({
          runtimeId: record?.runtimeId ?? DEFAULT_RUNTIME_ID,
          ...(record?.modelId ? { modelId: record.modelId } : {}),
        });
      },
    }),
    registerApiRoute('/web/factory/sessions/:sessionId/runtime', {
      method: 'PUT',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        if (!(await viewer(c)).ok) return c.json({ error: 'unauthorized' }, 401);
        const sessionId = c.req.param('sessionId')!;
        const parsed = sessionRuntimeBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
        const current = await sessions.get(sessionId);
        // A session's runtime is chosen before it starts: its transcript belongs to one runtime.
        if (!current && (await events.list(sessionId, { limit: 1 })).length > 0) {
          return c.json(
            { error: 'The session has already started on its default runtime', reason: 'session_started' },
            409,
          );
        }
        if (!(await sessions.assign(sessionId, parsed.data.runtimeId, parsed.data.modelId))) {
          return c.json({ error: 'The session already runs on another runtime', reason: 'runtime_fixed' }, 409);
        }
        return c.json({ ok: true });
      },
    }),
    registerApiRoute('/web/factory/projects/:projectId/runtime', {
      method: 'GET',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        const found = await projectScope(c);
        if (found.status !== 200) return c.json({ error: 'Project not found' }, found.status);
        return c.json({ runtimeId: (await sessions.getProjectDefault(found.scope)) ?? DEFAULT_RUNTIME_ID });
      },
    }),
    registerApiRoute('/web/factory/projects/:projectId/runtime', {
      method: 'PUT',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        const found = await projectScope(c);
        if (found.status !== 200) return c.json({ error: 'Project not found' }, found.status);
        const parsed = projectRuntimeBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
        await sessions.setProjectDefault(found.scope, parsed.data.runtimeId);
        return c.json({ ok: true });
      },
    }),
  ];
}
