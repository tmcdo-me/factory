// fork(claude-agent): a Claude Agent session's checkout, from Factory's own workspace factory.
import { stat } from 'node:fs/promises';

import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import type { Workspace, WorkspaceSkills } from '@mastra/core/workspace';

import { findSessionSandboxEntry, sessionLayout } from '../sandbox/session-sandbox.js';

// oxlint-disable-next-line typescript/no-explicit-any -- the workspace factory takes any request context.
type ResolveWorkspace = (context: {
  requestContext: RequestContext<any>;
  mastra?: Mastra;
}) => Promise<Workspace | undefined>;

/** What a Claude Agent session runs in, resolved from the workspace a Mastra Code session would get. */
export interface ClaudeAgentWorkspace {
  /** The session's checkout. */
  cwd: string;
  /** The sandbox's environment (git credentials for the checkout). */
  env: Record<string, string>;
  /** The session's skills, chosen as for a Mastra Code session (role, project edits). */
  skills?: WorkspaceSkills;
  /** The sandbox the checkout lives in. */
  sandbox?: unknown;
  /**
   * The request context Factory's tools run with for a turn the host sent with `hostContext`: the
   * host's entries (the signed-in caller) plus this session's controller context, as Mastra Code's
   * tools see it. The controller state is shared across turns, so what one tool heals stays healed.
   */
  requestContext(hostContext: unknown): RequestContext;
}

/**
 * Resolve a session's workspace exactly as a Mastra Code session would (same factory instance, same
 * access checks, same repository checkout, git credentials and sandbox), start its sandbox (which
 * clones the repository), and return the checkout path and the sandbox's environment.
 *
 * Claude Code runs as a process on this host for now, so only local sandboxes are supported; a
 * remote sandbox (Sprites) launches it inside the VM via `spawnClaudeCodeProcess` instead.
 */
export function createClaudeAgentWorkspaceResolver(options: {
  resolveWorkspace: ResolveWorkspace;
  getMastra: () => Mastra | undefined;
}) {
  return async (sessionId: string, requestContext: unknown): Promise<ClaudeAgentWorkspace> => {
    const contextFor = claudeAgentRequestContext(sessionId);
    const context = contextFor(requestContext);
    const workspace = await options.resolveWorkspace({ requestContext: context, mastra: options.getMastra() });
    const sandbox = workspace?.sandbox;
    if (!sandbox) throw new Error(`Session ${sessionId} has no workspace to run Claude Agent in`);
    // By provider, not `instanceof`: a host may load more than one copy of @mastra/core.
    if ((sandbox as { provider?: string }).provider !== 'local') {
      throw new Error('Claude Agent sessions need a local sandbox for now (FACTORY_SANDBOX_PROVIDER=local)');
    }
    const lifecycle = sandbox as unknown as {
      ensureRunning?(): Promise<void>;
      start?(): Promise<void>;
      _startPromise?: Promise<unknown>;
    };
    await (lifecycle.ensureRunning ? lifecycle.ensureRunning() : lifecycle.start?.());
    // A sandbox reports `running` before its start hook (which clones the repository) finishes, so a
    // start already in flight (Factory starts sandboxes eagerly) must settle before the checkout is
    // there. Session retirement waits on the same promise.
    await lifecycle._startPromise;
    // By instance: the memo is keyed by the source-control session row id, not this session id.
    const layout = sessionLayout(findSessionSandboxEntry(sandbox));
    if (!layout || !(await isDirectory(layout.root))) {
      throw new Error(`Session ${sessionId}'s checkout is not ready`);
    }
    const env = (sandbox as unknown as { getEnv?(): Record<string, string | undefined> }).getEnv?.() ?? {};
    return {
      cwd: layout.root,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      ...(workspace?.skills ? { skills: workspace.skills } : {}),
      sandbox,
      requestContext: contextFor,
    };
  };
}

/**
 * Request contexts for one Claude Agent session: a copy of the host's (identity, tenant, the
 * interactive marker) with the session's controller context, which Factory's workspace and tools
 * read the session from. One controller per session, so its state carries across turns.
 */
export function claudeAgentRequestContext(sessionId: string): (hostContext: unknown) => RequestContext {
  // The resolver reads the session from the controller context and records the checkout in its state.
  const state: Record<string, unknown> = {};
  const controller = {
    controllerId: 'claude-agent',
    sessionId,
    threadId: sessionId,
    resourceId: sessionId,
    state,
    getState: () => state,
    setState: async (updates: Record<string, unknown>) => {
      Object.assign(state, updates);
    },
  } as unknown as AgentControllerRequestContext;
  return hostContext => {
    // oxlint-disable-next-line typescript/no-explicit-any -- a copy of the host's request context, keys and all.
    const context = new RequestContext<any>(contextEntries(hostContext));
    context.set('controller', controller);
    return context;
  };
}

/**
 * The entries of the host's request context. Checked by shape, not `instanceof`: the host and this
 * package can load different copies of `@mastra/core`, and a failed class check silently drops the
 * caller's identity (the workspace then refuses the session).
 */
function contextEntries(requestContext: unknown): [string, unknown][] | undefined {
  const entries = (requestContext as { entries?: unknown } | null | undefined)?.entries;
  if (typeof entries !== 'function') return undefined;
  return [...(entries.call(requestContext) as Iterable<[string, unknown]>)];
}

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then(
    info => info.isDirectory(),
    () => false,
  );
}
