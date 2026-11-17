import type { ZodType } from 'zod';

import type { AnswerableKind, AnswerableRequest, ResponseFor } from './interactions';
import type { SessionWorkspace } from './workspace';

/**
 * A Factory tool, defined once and adapted by every runtime (Mastra `createTool`, Claude Agent MCP,
 * Factory's MCP endpoint). Deterministic input constraints belong in `input`; authorization,
 * existence and conflict checks belong in `execute`.
 */
export interface FactoryToolDef<I = any, O = any> {
  name: string;
  description: string;
  input: ZodType<I>;
  output?: ZodType<O>;
  /** `required` makes Factory ask the human before `execute` runs. */
  approval?: 'none' | 'required';
  execute(input: I, ctx: FactoryToolContext): Promise<O>;
}

export interface FactoryToolContext {
  sessionId: string;
  /**
   * The runtime's id for this call; ties `tool.*` events and interactions together. Empty when the
   * runtime gave the call none (a tool run outside a model's turn); a tool that keys anything on the
   * call (an idempotent ingress, a streamed post) refuses such a call.
   */
  callId: string;
  orgId: string;
  userId: string;
  projectId?: string;
  workItemId?: string;
  phase?: string;
  /**
   * The session's workspace: where workspace-backed tools (git push, files) act. Absent where the
   * call has no session workspace, such as Factory's MCP endpoint; such tools then fail.
   */
  workspace?: SessionWorkspace;
  signal: AbortSignal;
  /** Ask the human and wait. Resolves with the answer; rejects if the interaction is cancelled. */
  interact<K extends AnswerableKind>(request: Extract<AnswerableRequest, { kind: K }>): Promise<ResponseFor<K>>;
}

/**
 * Marks a value made by {@link defineFactoryTool}. A `Symbol.for` key, so separate copies of this
 * package in one process agree on it; enumerable, so a spread copy of a definition keeps it.
 */
export const FACTORY_TOOL_DEF: unique symbol = Symbol.for('factory.tool.def');

/** Define a Factory tool: keeps `I`/`O` inferred from the schemas and marks it as a definition. */
export function defineFactoryTool<I, O>(def: FactoryToolDef<I, O>): FactoryToolDef<I, O> {
  return Object.assign(def, { [FACTORY_TOOL_DEF]: true });
}

/** Whether a tool is a Factory tool definition (made with {@link defineFactoryTool}), not some other tool. */
export function isFactoryToolDef(tool: unknown): tool is FactoryToolDef {
  return (
    typeof tool === 'object' && tool !== null && (tool as { [FACTORY_TOOL_DEF]?: unknown })[FACTORY_TOOL_DEF] === true
  );
}
