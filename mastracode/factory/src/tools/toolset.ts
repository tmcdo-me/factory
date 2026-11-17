// fork(claude-agent): a session's Factory tools, defined once for every runtime (spec §3.3, slice 4).
import { randomUUID } from 'node:crypto';

import { isFactoryToolDef as isDefinition } from '@factory/agent-runtime';
import type { FactoryToolContext, FactoryToolDef, SessionWorkspace } from '@factory/agent-runtime';
import { mastraTool } from '@factory/runtime-mastra-code';
import type { MastraToolCall, MastraToolContextOf } from '@factory/runtime-mastra-code';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraSandbox } from '@mastra/core/workspace';

import { factoryUserOrgId, getFactoryAuthUserFromContext, getFactoryAuthUserId } from '../auth.js';
import type { IntegrationTools } from '../integrations/base.js';
import { sessionSandboxProcesses } from '../sandbox/sandbox-processes.js';
import { findSessionSandboxEntry, sessionLayout } from '../sandbox/session-sandbox.js';
import { turnSession } from '../session/turn-session.js';
import type { FactoryToolScope } from './scope.js';

/** A Mastra tool, as Mastra Code's `extraTools` takes one. */
export type MastraSessionTool = NonNullable<IntegrationTools[string]>;

/**
 * One of a session's Factory tools: a runtime-neutral definition, or a Mastra tool from a group not
 * ported to definitions yet (and the tools a deployment configures, which are Mastra tools). Mastra
 * Code gets every definition adapted (`mastraSessionTools`); Claude Agent runs definitions directly.
 */
export type FactorySessionTool = FactoryToolDef | MastraSessionTool;
export type FactorySessionTools = Record<string, FactorySessionTool | undefined>;

/** A definition (made with `defineFactoryTool`), as opposed to a Mastra tool. */
export function isFactoryToolDef(tool: FactorySessionTool): tool is FactoryToolDef {
  return isDefinition(tool);
}

/** Every tool as a Mastra tool: definitions adapted with `contextOf`, Mastra tools as they are. */
export function mastraSessionTools(tools: FactorySessionTools, contextOf: MastraToolContextOf): IntegrationTools {
  const adapted: IntegrationTools = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (tool) adapted[name] = isFactoryToolDef(tool) ? mastraTool(tool, contextOf) : tool;
  }
  return adapted;
}

/** Who a turn's tool calls act as: the signed-in caller, or the shared `local` tenant without auth. */
export function toolIdentity(requestContext: RequestContext): { orgId: string; userId: string } {
  const user = getFactoryAuthUserFromContext(requestContext);
  return { orgId: factoryUserOrgId(user) ?? 'local', userId: getFactoryAuthUserId(user) ?? 'local' };
}

/** The session and thread a turn's request context carries (`controller`, set by both runtimes). */
function turnIds(requestContext: RequestContext | undefined): { sessionId: string; threadId: string } {
  const session = turnSession(requestContext);
  return { sessionId: session?.sessionId ?? '', threadId: session?.threadId ?? '' };
}

/**
 * The seam's view of a Mastra Code agent's workspace: its sandbox (commands, and processes where the
 * sandbox can launch them), the session's checkout in it, and its filesystem. `undefined` when the
 * agent's workspace has neither a sandbox nor a filesystem.
 */
export function mastraSessionWorkspace(workspace: unknown): SessionWorkspace | undefined {
  const { sandbox, filesystem } = (workspace ?? {}) as Pick<SessionWorkspace, 'filesystem'> & {
    sandbox?: MastraSandbox;
  };
  if (!sandbox && !filesystem) return undefined;
  const processes = sandbox ? sessionSandboxProcesses(sandbox) : undefined;
  return {
    // A provider that launches no processes (Platform, E2B) runs only commands: `remote`.
    kind: processes?.kind ?? 'remote',
    checkoutDir: (sandbox && sessionLayout(findSessionSandboxEntry(sandbox))?.root) ?? '',
    ...(sandbox ? { sandbox } : {}),
    ...(filesystem ? { filesystem } : {}),
    env: async () =>
      Object.fromEntries(
        Object.entries(
          (sandbox as { getEnv?(): Record<string, string | undefined> } | undefined)?.getEnv?.() ?? {},
        ).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    spawn: (command, args, options) => {
      if (!processes) throw new Error("This session's sandbox cannot launch processes");
      return processes.spawn(command, args, options);
    },
  };
}

/** Asking a person from a tool waits on the interaction broker, which Mastra Code sessions reach in slice 5. */
function cannotAsk(toolName: string): FactoryToolContext['interact'] {
  return async () => {
    throw new Error(`Factory tool ${toolName} cannot ask a person from here`);
  };
}

/**
 * The context of a Factory tool call in a Mastra Code turn: the session and caller of the turn the
 * tools were built for. A call that brings the request context of another session or thread is
 * refused: a definition acts only for its own turn (a context that names none acts for it). The call id is Mastra's; a call without one
 * (a tool run outside a model's turn) gets an empty id, which the tools that key on it refuse.
 */
export function mastraCodeToolContext(turn: RequestContext): MastraToolContextOf {
  const own = turnIds(turn);
  return (call: MastraToolCall) => {
    if (call.requestContext && call.requestContext !== turn) {
      const called = turnIds(call.requestContext);
      // A call whose context names no session (a direct execution) still acts for the tools' turn.
      const names = called.sessionId !== '' || called.threadId !== '';
      if (names && (called.sessionId !== own.sessionId || called.threadId !== own.threadId)) {
        throw new Error(
          `Factory tool ${call.toolName} was built for another session or thread than this call's; nothing was done.`,
        );
      }
    }
    const context: FactoryToolContext = {
      sessionId: own.sessionId,
      callId: call.callId ?? '',
      ...toolIdentity(turn),
      signal: call.signal ?? new AbortController().signal,
      interact: cannotAsk(call.toolName),
    };
    return withLazyWorkspace(context, call.workspace);
  };
}

/**
 * Gives the context the call's session workspace, built only when a tool reads it (most never do),
 * and at most once. Absent when the agent's workspace has none to offer.
 */
function withLazyWorkspace(context: FactoryToolContext, agentWorkspace: unknown): FactoryToolContext {
  let built: { workspace: SessionWorkspace | undefined } | undefined;
  return Object.defineProperty(context, 'workspace', {
    enumerable: true,
    get: () => (built ??= { workspace: mastraSessionWorkspace(agentWorkspace) }).workspace,
  });
}

/**
 * Mastra Code's `extraTools` from Factory's per-turn session tools: definitions adapted to Mastra
 * tools, with the turn's session and caller as their context.
 */
export function mastraCodeExtraTools(
  build: (context: { requestContext: RequestContext }) => Promise<FactorySessionTools>,
): (context: { requestContext: RequestContext }) => Promise<IntegrationTools> {
  return async ({ requestContext }) =>
    mastraSessionTools(await build({ requestContext }), mastraCodeToolContext(requestContext));
}

/**
 * The context of a Factory tool call that comes from outside any turn (Factory's MCP endpoint): the
 * scope's, with an id of its own for each call (an MCP client names none).
 */
export function scopeToolContext(scope: Pick<FactoryToolScope, 'sessionId' | 'orgId' | 'userId'>): MastraToolContextOf {
  return (call: MastraToolCall) => ({
    sessionId: scope.sessionId,
    callId: call.callId ?? randomUUID(),
    orgId: scope.orgId,
    userId: scope.userId,
    signal: call.signal ?? new AbortController().signal,
    interact: cannotAsk(call.toolName),
  });
}
