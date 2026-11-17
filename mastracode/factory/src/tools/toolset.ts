// fork(claude-agent): a session's Factory tools, defined once for every runtime (spec §3.3, slice 4).
import { randomUUID } from 'node:crypto';

import type { FactoryToolContext, FactoryToolDef } from '@factory/agent-runtime';
import { mastraTool } from '@factory/runtime-mastra-code';
import type { MastraToolCall, MastraToolContextOf } from '@factory/runtime-mastra-code';
import type { RequestContext } from '@mastra/core/request-context';

import { factoryUserOrgId, getFactoryAuthUserFromContext, getFactoryAuthUserId } from '../auth.js';
import type { IntegrationTools } from '../integrations/base.js';
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

/** A definition, as opposed to a Mastra tool (which has an `id` and `inputSchema` instead). */
export function isFactoryToolDef(tool: FactorySessionTool): tool is FactoryToolDef {
  return typeof (tool as Partial<FactoryToolDef>).name === 'string' && 'input' in tool;
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

/** The session id a turn's request context carries (`controller`, set by both runtimes). */
function turnSessionId(requestContext: RequestContext | undefined): string | undefined {
  const controller = (typeof requestContext?.get === 'function' ? requestContext.get('controller') : undefined) as
    | { sessionId?: unknown }
    | undefined;
  return typeof controller?.sessionId === 'string' ? controller.sessionId : undefined;
}

/** Asking a person from a tool waits on the interaction broker, which Mastra Code sessions reach in slice 5. */
function cannotAsk(toolName: string): FactoryToolContext['interact'] {
  return async () => {
    throw new Error(`Factory tool ${toolName} cannot ask a person from here`);
  };
}

/**
 * The context of a Factory tool call in a Mastra Code turn: the turn's session and caller, from the
 * request context Mastra passes the call (else the one the turn's tools were built with).
 */
export function mastraCodeToolContext(turn: RequestContext): MastraToolContextOf {
  return (call: MastraToolCall) => {
    const requestContext = call.requestContext ?? turn;
    return {
      sessionId: turnSessionId(requestContext) ?? turnSessionId(turn) ?? '',
      callId: call.callId ?? randomUUID(),
      ...toolIdentity(requestContext),
      signal: call.signal ?? new AbortController().signal,
      interact: cannotAsk(call.toolName),
    };
  };
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

/** The context of a Factory tool call that comes from outside any turn (Factory's MCP endpoint): the scope's. */
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
