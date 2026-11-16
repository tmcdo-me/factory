// fork(claude-agent): Factory's agent runtime API.
export const MASTRA_CODE_RUNTIME = 'mastra-code';
export const CLAUDE_AGENT_RUNTIME = 'claude-agent';

/** Names to show before the catalog loads. Claude Agent is never called "Claude Code" in the UI. */
const RUNTIME_LABELS: Record<string, string> = {
  [MASTRA_CODE_RUNTIME]: 'Mastra Code',
  [CLAUDE_AGENT_RUNTIME]: 'Claude Agent',
};

/** A runtime's display name: the catalog's label, else the built-in one, else its id. */
export function runtimeLabel(catalog: FactoryRuntimeCatalog | undefined, runtimeId: string): string {
  return catalog?.runtimes.find(runtime => runtime.id === runtimeId)?.label ?? RUNTIME_LABELS[runtimeId] ?? runtimeId;
}

export interface FactoryRuntime {
  id: string;
  label: string;
  /** Runtimes with their own model list (Claude Agent). Mastra Code uses the model catalog. */
  models?: readonly { id: string; label: string }[];
}

export interface FactoryRuntimeCatalog {
  runtimes: FactoryRuntime[];
  defaultRuntimeId: string;
}

export interface SessionRuntime {
  runtimeId: string;
  modelId?: string;
  /**
   * Where the session's transcript is drawn from: Factory's event log (the default), or Mastra memory
   * for a Mastra Code session whose conversation began before Factory logged its events.
   */
  transcript?: 'factory' | 'mastra';
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  // A route's `message` is for people; its `error` may be a code (`organization_required`).
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  // fork(claude-agent): the route's code stays on the error, for callers that act on it.
  throw Object.assign(new Error(body.message ?? body.error ?? `${what} failed (${response.status})`), {
    ...(body.error ? { code: body.error } : {}),
  });
}

export const fetchRuntimeCatalog = async (baseUrl: string) =>
  json<FactoryRuntimeCatalog>(
    await fetch(`${baseUrl}/web/factory/runtimes`, { credentials: 'include' }),
    'Loading runtimes',
  );

export const fetchSessionRuntime = async (baseUrl: string, sessionId: string) =>
  json<SessionRuntime>(
    await fetch(`${baseUrl}/web/factory/sessions/${encodeURIComponent(sessionId)}/runtime`, { credentials: 'include' }),
    'Loading the session runtime',
  );

export const assignSessionRuntime = async (baseUrl: string, sessionId: string, runtime: SessionRuntime) =>
  json<{ ok: true }>(
    await fetch(`${baseUrl}/web/factory/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runtime),
    }),
    'Choosing the session runtime',
  );

export const fetchProjectRuntime = async (baseUrl: string, projectId: string) =>
  json<{ runtimeId: string }>(
    await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(projectId)}/runtime`, { credentials: 'include' }),
    "Loading the project's default runtime",
  );

export const setProjectRuntime = async (baseUrl: string, projectId: string, runtimeId: string) =>
  json<{ ok: true }>(
    await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(projectId)}/runtime`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeId }),
    }),
    "Setting the project's default runtime",
  );

/** How many Claude Agent turns this server runs at once (spec slice 13). */
export interface ClaudeAgentConcurrency {
  /** What Settings set: a cap, `0` for no limit, `null` to follow the server's default. */
  maxConcurrent: number | null;
  /** The server's default (`FACTORY_CLAUDE_AGENT_MAX_CONCURRENT`), `null` for no limit. */
  defaultMaxConcurrent: number | null;
  /** The cap in force, `null` for no limit. */
  effective: number | null;
  running: number;
  waiting: number;
}

const CONCURRENCY_PATH = '/web/factory/runtimes/claude-agent/concurrency';

export const fetchClaudeAgentConcurrency = async (baseUrl: string) =>
  json<ClaudeAgentConcurrency>(
    await fetch(`${baseUrl}${CONCURRENCY_PATH}`, { credentials: 'include' }),
    'Loading the Claude Agent limit',
  );

export const setClaudeAgentConcurrency = async (baseUrl: string, maxConcurrent: number | null) =>
  json<ClaudeAgentConcurrency>(
    await fetch(`${baseUrl}${CONCURRENCY_PATH}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrent }),
    }),
    'Setting the Claude Agent limit',
  );

export const runtimeKeys = {
  catalog: ['factory-runtimes'] as const,
  claudeAgentConcurrency: ['factory-claude-agent-concurrency'] as const,
  session: (sessionId: string) => ['factory-session-runtime', sessionId] as const,
  project: (projectId: string) => ['factory-project-runtime', projectId] as const,
};
