// fork(claude-agent): a Claude Agent session's checkout, from Factory's own workspace factory.
import type { SandboxProcesses, SessionWorkspace } from '@factory/agent-runtime';
import {
  ensureBashSandbox,
  ensureClaudeCode,
  runInProcesses,
  sandboxClaudeCodeLaunch,
} from '@factory/runtime-claude-agent';
import type { ClaudeCodeLaunch, InstalledClaudeCode, RunInSandbox } from '@factory/runtime-claude-agent';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import type { MastraSandbox, Workspace, WorkspaceSkills } from '@mastra/core/workspace';

import { sessionSandboxProcesses } from '../sandbox/sandbox-processes.js';
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
   * The session's Factory workspace. Factory's workspace-backed tools (`source_control_*` and the
   * like) take the sandbox from it, as they do from a Mastra Code agent's workspace.
   */
  workspace?: Workspace;
  /**
   * Where Claude Code runs when not on this host: inside the session's sandbox (a Sprite), with
   * the binary its install step put there. Absent for a local sandbox.
   */
  launch?: ClaudeCodeLaunch;
  /** The session's workspace as the runtime seam describes it (what Factory's tools get). */
  sessionWorkspace?: SessionWorkspace;
  /**
   * The sandbox's environment as it is now, after Factory refreshed what it keeps current (a
   * GitHub token re-minted once it is stale): read whenever Claude Code (re)starts.
   */
  freshEnv?(): Promise<Record<string, string>>;
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
 * Claude Code runs where the checkout is: as a process on this host for a local sandbox, or inside
 * the session's Sprite, launched through the sandbox's processes (`SANDBOX_PROCESSES`) with the
 * Claude Code its install step put there. Other sandboxes (Platform, E2B) can't run it.
 */
export function createClaudeAgentWorkspaceResolver(options: {
  resolveWorkspace: ResolveWorkspace;
  getMastra: () => Mastra | undefined;
  /**
   * The memory resource the session's thread lives under, which its run binding records. Factory's
   * tools find the card a session works by thread and resource, so they must match the binding.
   */
  resourceIdOf?: (sessionId: string) => Promise<string | undefined>;
  /** The session's Claude model, which Factory's phase context names in review phases. */
  modelIdOf?: (sessionId: string) => Promise<string | undefined>;
  /** Installs Claude Code in a sandbox that runs it remotely; injected for tests. */
  installClaudeCode?: (run: RunInSandbox) => Promise<InstalledClaudeCode>;
  /** Installs what Claude Code's Bash sandbox needs in such a sandbox; injected for tests. */
  installBashSandbox?: (run: RunInSandbox) => Promise<void>;
}) {
  /**
   * On every open, never remembered: the sandbox may have been reset (a new VM behind the same
   * object) or its binary changed since. A verified sandbox answers with one checksum. Run through
   * the sandbox's own processes with no environment, so no credential is near it or its errors.
   * With Claude Code's Bash sandbox, what it needs (bubblewrap, socat) is installed the same way,
   * and every launch checks that it can run (`sandboxClaudeCodeLaunch`).
   */
  const claudeCodeIn = async (processes: SandboxProcesses, bashSandbox: boolean): Promise<ClaudeCodeLaunch> => {
    const installed = await (options.installClaudeCode ?? ensureClaudeCode)(runInProcesses(processes));
    if (bashSandbox) await (options.installBashSandbox ?? ensureBashSandbox)(runInProcesses(processes));
    return sandboxClaudeCodeLaunch(processes, installed, { bashSandbox });
  };
  return async (
    sessionId: string,
    requestContext: unknown,
    open: { bashSandbox?: boolean } = {},
  ): Promise<ClaudeAgentWorkspace> => {
    const [resourceId, modelId] = await Promise.all([
      options.resourceIdOf?.(sessionId),
      options.modelIdOf?.(sessionId),
    ]);
    const contextFor = claudeAgentRequestContext(sessionId, {
      ...(resourceId ? { resourceId } : {}),
      ...(modelId ? { modelId } : {}),
    });
    const context = contextFor(requestContext);
    const workspace = await options.resolveWorkspace({ requestContext: context, mastra: options.getMastra() });
    const sandbox = workspace?.sandbox;
    if (!sandbox) throw new Error(`Session ${sessionId} has no workspace to run Claude Agent in`);
    const processes = sessionSandboxProcesses(sandbox);
    if (!processes) {
      throw new Error(
        `Claude Agent sessions need a local or Sprites sandbox (FACTORY_SANDBOX_PROVIDER=local or sprites), not ${sandbox.provider}`,
      );
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
    if (!layout || !(await processes.files.isDirectory(layout.root))) {
      throw new Error(`Session ${sessionId}'s checkout is not ready`);
    }
    const currentEnv = () =>
      Object.fromEntries(
        Object.entries(
          (sandbox as unknown as { getEnv?(): Record<string, string | undefined> }).getEnv?.() ?? {},
        ).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    const env = currentEnv();
    const launch = processes.kind === 'local' ? undefined : await claudeCodeIn(processes, open.bashSandbox === true);
    // Factory re-mints a stale GitHub token before any sandbox command; a no-op command triggers it.
    const freshEnv = async () => {
      await sandbox.executeCommand?.('true').catch(() => undefined);
      return currentEnv();
    };
    return {
      cwd: layout.root,
      env,
      ...(workspace?.skills ? { skills: workspace.skills } : {}),
      sandbox,
      ...(workspace ? { workspace } : {}),
      ...(launch ? { launch } : {}),
      sessionWorkspace: {
        kind: processes.kind,
        checkoutDir: layout.root,
        sandbox: sandbox as MastraSandbox,
        ...(workspace?.filesystem ? { filesystem: workspace.filesystem } : {}),
        env: freshEnv,
        spawn: processes.spawn,
      },
      freshEnv,
      requestContext: contextFor,
    };
  };
}

/**
 * Request contexts for one Claude Agent session: a copy of the host's (identity, tenant, the
 * interactive marker) with the session's controller context, which Factory's workspace and tools
 * read the session from. One controller per session, so its state carries across turns.
 */
export function claudeAgentRequestContext(
  sessionId: string,
  options: { resourceId?: string; modelId?: string } = {},
): (hostContext: unknown) => RequestContext {
  // The resolver reads the session from the controller context and records the checkout in its state.
  const state: Record<string, unknown> = {};
  const controller = {
    controllerId: 'claude-agent',
    sessionId,
    threadId: sessionId,
    resourceId: options.resourceId ?? sessionId,
    ...(options.modelId ? { session: { id: sessionId, ownerId: '', modelId: options.modelId } } : {}),
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
