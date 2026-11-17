import type { FactoryToolContext, FactoryToolDef } from '@factory/agent-runtime';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import type { Tool, ToolExecutionContext } from '@mastra/core/tools';

// oxlint-disable-next-line typescript/no-explicit-any -- Factory's tools have every input and output shape.
export type MastraTool = Tool<any, any, any, any>;

/** What Mastra tells a tool about one call, for the host to build the call's Factory context from. */
export interface MastraToolCall {
  toolName: string;
  /** The model's tool call id; absent where no agent made the call (an MCP client, a direct call). */
  callId?: string;
  signal?: AbortSignal;
  /** The request context of the turn making the call. */
  requestContext?: RequestContext;
  /** The agent's workspace (its sandbox and filesystem), when it has one. */
  workspace?: ToolExecutionContext['workspace'];
}

/** Builds a call's {@link FactoryToolContext}: who it acts as, in which session, and how it asks a person. */
export type MastraToolContextOf = (call: MastraToolCall) => FactoryToolContext | Promise<FactoryToolContext>;

/**
 * A Factory tool as a Mastra tool, for Mastra Code's agent (`extraTools`) and Mastra's MCP server.
 * Mastra validates the input against the definition's schema (a rejected input comes back as
 * Mastra's validation error, as for any Mastra tool) and the call runs the definition's `execute`
 * with the context `contextOf` builds for it. `approval: 'required'` becomes `requireApproval`, so
 * Mastra Code's permission rules decide whether the person is asked.
 */
export function mastraTool(def: FactoryToolDef, contextOf: MastraToolContextOf): MastraTool {
  return createTool({
    id: def.name,
    description: def.description,
    inputSchema: def.input,
    ...(def.output ? { outputSchema: def.output } : {}),
    ...(def.approval ? { requireApproval: def.approval === 'required' } : {}),
    execute: async (input: unknown, execution: ToolExecutionContext) =>
      def.execute(input, await contextOf(mastraToolCall(def.name, execution))),
  }) as MastraTool;
}

function mastraToolCall(toolName: string, execution: ToolExecutionContext | undefined): MastraToolCall {
  const callId = execution?.agent?.toolCallId;
  return {
    toolName,
    ...(callId ? { callId } : {}),
    ...(execution?.abortSignal ? { signal: execution.abortSignal } : {}),
    ...(execution?.requestContext ? { requestContext: execution.requestContext as RequestContext } : {}),
    ...(execution?.workspace ? { workspace: execution.workspace } : {}),
  };
}
