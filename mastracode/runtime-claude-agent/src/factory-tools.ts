import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AnyZodRawShape, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { FactoryToolContext, FactoryToolDef } from '@factory/agent-runtime';

import { FACTORY_MCP_SERVER } from './tool-classification';

/** One call of a Factory tool, as Claude Code made it. */
export interface FactoryToolCall {
  /** Claude's `tool_use` id: the transcript's tool call, and what an interaction is answered by. */
  callId: string;
  /** Aborts when Claude Code cancels the call (an interrupted turn). */
  signal: AbortSignal;
  /** The run the call belongs to. */
  runId?: string;
}

/** Factory's tools for one session, and the context each call runs with. */
export interface ClaudeAgentFactoryTools {
  defs: readonly FactoryToolDef[];
  context(call: FactoryToolCall): FactoryToolContext | Promise<FactoryToolContext>;
}

/** Claude Code names the calling `tool_use` in each MCP `tools/call` request's `_meta`. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';

/** Appended to the system prompt: Factory's skills and instructions name tools without the MCP prefix. */
export const FACTORY_TOOLS_INSTRUCTIONS = [
  `Factory's tools are the \`mcp__${FACTORY_MCP_SERVER}__*\` tools.`,
  `Factory's instructions and skills name them without that prefix: \`submit_plan\` is \`mcp__${FACTORY_MCP_SERVER}__submit_plan\`, \`factory_transition_work_item\` is \`mcp__${FACTORY_MCP_SERVER}__factory_transition_work_item\`.`,
  `Use \`mcp__${FACTORY_MCP_SERVER}__ask_user\` to ask the person a question and \`mcp__${FACTORY_MCP_SERVER}__submit_plan\` to submit a plan for their approval; both wait for the answer.`,
].join(' ');

/**
 * Factory's tools as the in-process MCP server `factory`. Each call runs the tool's `execute` with
 * the context Factory binds for it; results reach Claude as text and failures as tool errors.
 */
export function createFactoryMcpServer(
  tools: ClaudeAgentFactoryTools,
  options: { currentRunId(): string | undefined; newId(): string },
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: FACTORY_MCP_SERVER,
    version: '1.0.0',
    // Factory's tools are few and the skills rely on them; never defer them behind tool search.
    alwaysLoad: true,
    tools: tools.defs.map(def =>
      // A whole Zod object (not just a raw shape) keeps the tool's own refinements; the MCP server
      // accepts either at runtime.
      tool(def.name, def.description, def.input as unknown as AnyZodRawShape, async (args, extra) => {
        const call = callOf(extra, options);
        try {
          const context = await tools.context(call);
          return { content: [{ type: 'text', text: resultText(await def.execute(args, context)) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          };
        }
      }),
    ),
  });
}

function callOf(extra: unknown, options: { currentRunId(): string | undefined; newId(): string }): FactoryToolCall {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const callId = typeof meta?.[TOOL_USE_ID_META] === 'string' ? (meta[TOOL_USE_ID_META] as string) : options.newId();
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  const runId = options.currentRunId();
  return {
    callId,
    signal: signal instanceof AbortSignal ? signal : new AbortController().signal,
    ...(runId ? { runId } : {}),
  };
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'Done.';
  return JSON.stringify(result);
}

/** The MCP names Claude Code gives Factory's tools. */
export function factoryMcpToolNames(defs: readonly Pick<FactoryToolDef, 'name'>[]): string[] {
  return defs.map(def => `mcp__${FACTORY_MCP_SERVER}__${def.name}`);
}
