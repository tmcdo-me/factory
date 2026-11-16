// fork(claude-agent): which agent runtimes exist, which one a session runs on, and each project's default.
/**
 * - `GET  /web/factory/runtimes` — the runtimes this deployment offers (Claude Agent with its models).
 * - `GET  /web/factory/sessions/:sessionId/runtime` — the session's runtime (default when unset), and
 *   where its transcript is drawn from: `factory` (its event log), or `mastra` for a Mastra Code
 *   session whose conversation began before Factory logged its events. 503 while that can't be
 *   told (Factory starting, storage unreachable): the UI asks again rather than draw it wrong.
 * - `PUT  /web/factory/sessions/:sessionId/runtime` — choose it, before the session's first message;
 *   owner-only (`createSessionAccessGuard`).
 * - `GET|PUT /web/factory/projects/:projectId/runtime` — the project's default for new sessions.
 * - `GET|PUT /web/factory/runtimes/claude-agent/concurrency` — how many Claude Agent turns run at once,
 *   on this whole server (spec slice 13).
 */
import type { EventLog } from '@factory/agent-runtime';
import { CLAUDE_AGENT_MODELS, CLAUDE_AGENT_RUNTIME_ID } from '@factory/runtime-claude-agent';
import { MASTRA_CODE_RUNTIME_ID } from '@factory/runtime-mastra-code';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';

import { CLAUDE_AGENT_MAX_CONCURRENT_LIMIT } from '../session/claude-agent-concurrency.js';
import type { ClaudeAgentConcurrency } from '../session/claude-agent-concurrency.js';
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
/** A cap, `0` for no limit, or `null` to follow the server's default. */
const concurrencyBody = z.object({
  maxConcurrent: z.number().int().min(0).max(CLAUDE_AGENT_MAX_CONCURRENT_LIMIT).nullable(),
});

const ADMIN_REQUIRED = {
  error: 'organization_admin_required',
  message: 'Organization administrator access is required to see or change the Claude Agent limit.',
};

export interface AgentRuntimeRoutesDependencies {
  auth: RouteAuth;
  sessions: Pick<AgentSessionsStorage, 'get' | 'assign' | 'getProjectDefault' | 'setProjectDefault'>;
  events: Pick<EventLog, 'list'>;
  projects: { get(args: { orgId: string; id: string }): Promise<unknown> };
  /**
   * Whether a Mastra Code session's conversation began before its event log (`historyPredatesEventLog`).
   * Without it every session is drawn from its event log.
   */
  historyPredatesLog?: (sessionId: string) => Promise<boolean>;
  /** The Claude Agent concurrency cap; without it the concurrency routes answer 404. */
  claudeAgentConcurrency?: Pick<ClaudeAgentConcurrency, 'state' | 'set'>;
}

export function buildAgentRuntimeRoutes({
  auth,
  sessions,
  events,
  projects,
  historyPredatesLog,
  claudeAgentConcurrency,
}: AgentRuntimeRoutesDependencies): ApiRoute[] {
  const viewer = async (c: ReturnType<typeof loose>) => {
    if (!auth.enabled()) return { ok: true as const, orgId: undefined };
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    return tenant ? { ok: true as const, orgId: tenant.orgId } : { ok: false as const };
  };

  /**
   * The project, owned by the caller's organization. With auth on, a caller with no organization has
   * no project (boards require one), so none of its runtime can be read or set. With auth off every
   * project is unscoped (`local`).
   */
  const projectScope = async (c: ReturnType<typeof loose>) => {
    const projectId = c.req.param('projectId');
    if (!auth.enabled()) {
      return projectId ? { status: 200 as const, scope: { orgId: 'local', projectId } } : { status: 404 as const };
    }
    const who = await viewer(c);
    if (!who.ok) return { status: 401 as const };
    if (!who.orgId) return { status: 403 as const };
    if (!projectId || !(await projects.get({ orgId: who.orgId, id: projectId }))) return { status: 404 as const };
    return { status: 200 as const, scope: { orgId: who.orgId, projectId } };
  };
  const isAdmin = async (c: ReturnType<typeof loose>, orgId: string | undefined) =>
    !auth.enabled() || (orgId !== undefined && (await auth.isOrganizationAdmin(c, orgId)));
  const scopeError = (status: 401 | 403 | 404) =>
    status === 403
      ? { error: 'organization_required', message: 'Agent runtimes are set per organization.' }
      : { error: status === 401 ? 'unauthorized' : 'Project not found' };

  /** Where a session's history lives; `undefined` when a Mastra Code session's can't be told now. */
  const transcriptSource = async (runtimeId: string, sessionId: string): Promise<'factory' | 'mastra' | undefined> => {
    if (runtimeId !== MASTRA_CODE_RUNTIME_ID || !historyPredatesLog) return 'factory';
    try {
      return (await historyPredatesLog(sessionId)) ? 'mastra' : 'factory';
    } catch (error) {
      console.warn(`[factory] Session ${sessionId}: checking where its history lives failed`, error);
      return undefined;
    }
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
        const sessionId = c.req.param('sessionId')!;
        const record = await sessions.get(sessionId);
        const runtimeId = record?.runtimeId ?? DEFAULT_RUNTIME_ID;
        const transcript = await transcriptSource(runtimeId, sessionId);
        if (!transcript) {
          return c.json(
            { error: 'unavailable', message: "Where the session's history lives could not be read; try again." },
            503,
          );
        }
        return c.json({ runtimeId, ...(record?.modelId ? { modelId: record.modelId } : {}), transcript });
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
        if (found.status !== 200) return c.json(scopeError(found.status), found.status);
        return c.json({ runtimeId: (await sessions.getProjectDefault(found.scope)) ?? DEFAULT_RUNTIME_ID });
      },
    }),
    registerApiRoute('/web/factory/projects/:projectId/runtime', {
      method: 'PUT',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        const found = await projectScope(c);
        if (found.status !== 200) return c.json(scopeError(found.status), found.status);
        const parsed = projectRuntimeBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
        await sessions.setProjectDefault(found.scope, parsed.data.runtimeId);
        return c.json({ ok: true });
      },
    }),
    // The cap is the server's (one Claude subscription), not a project's: only an organization
    // administrator may read or change it (with auth off, the operator is the only caller).
    registerApiRoute('/web/factory/runtimes/claude-agent/concurrency', {
      method: 'GET',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        const who = await viewer(c);
        if (!who.ok) return c.json({ error: 'unauthorized' }, 401);
        if (auth.enabled() && !who.orgId) return c.json(scopeError(403), 403);
        if (!(await isAdmin(c, who.orgId))) return c.json(ADMIN_REQUIRED, 403);
        if (!claudeAgentConcurrency) return c.json({ error: 'not_found' }, 404);
        return c.json(claudeAgentConcurrency.state());
      },
    }),
    registerApiRoute('/web/factory/runtimes/claude-agent/concurrency', {
      method: 'PUT',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        const who = await viewer(c);
        if (!who.ok) return c.json({ error: 'unauthorized' }, 401);
        if (auth.enabled() && !who.orgId) return c.json(scopeError(403), 403);
        if (!(await isAdmin(c, who.orgId))) return c.json(ADMIN_REQUIRED, 403);
        if (!claudeAgentConcurrency) return c.json({ error: 'not_found' }, 404);
        const parsed = concurrencyBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
        await claudeAgentConcurrency.set(parsed.data.maxConcurrent);
        return c.json(claudeAgentConcurrency.state());
      },
    }),
  ];
}
