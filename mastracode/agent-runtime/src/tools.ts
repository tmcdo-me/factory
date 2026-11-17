import type { ZodType } from 'zod';

import type { InteractionKind, InteractionRequest, ResponseFor } from './interactions';
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
  /** The runtime's id for this call; ties `tool.*` events and interactions together. */
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
  interact<K extends InteractionKind>(request: Extract<InteractionRequest, { kind: K }>): Promise<ResponseFor<K>>;
}

/** Identity helper that keeps `I`/`O` inferred from the schemas. */
export function defineFactoryTool<I, O>(def: FactoryToolDef<I, O>): FactoryToolDef<I, O> {
  return def;
}
