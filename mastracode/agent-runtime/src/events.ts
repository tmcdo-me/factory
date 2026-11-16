/**
 * Factory's runtime-neutral event format.
 *
 * Every agent runtime adapter translates its native stream into these events. Factory persists
 * them (one append-only log per session), derives the transcript from them, serves them to the UI,
 * and evaluates board rules and audits against them. Nothing outside an adapter sees a runtime's
 * native message or event types.
 */

import type { PendingInteraction, InteractionResponse } from './interactions';
import type { TurnInput } from './runtime';

/**
 * What a tool does, independent of what a runtime calls it. Audits and UI renderers key on this,
 * so Mastra Code's `execute_command` and Claude Agent's `Bash` are both `shell`.
 */
export type ToolCategory = 'shell' | 'file.read' | 'file.write' | 'search' | 'web' | 'factory' | 'other';

/**
 * Who runs a tool. `runtime` tools are the agent's own (Claude's Read/Edit/Bash, Mastra Code's
 * workspace tools); `factory` tools are Factory's `FactoryToolDef`s, executed by Factory.
 */
export type ToolExecutor = 'runtime' | 'factory';

export type RunEndReason = 'complete' | 'aborted' | 'error' | 'awaiting_interaction';

export type FactoryEvent =
  | { type: 'run.started'; runId: string; input: TurnInput }
  | { type: 'run.ended'; runId: string; reason: RunEndReason; error?: string }
  | { type: 'message.started'; messageId: string; role: 'assistant' | 'user'; runId?: string }
  | { type: 'message.delta'; messageId: string; part: 'text' | 'reasoning'; delta: string }
  | { type: 'message.ended'; messageId: string }
  | {
      type: 'tool.started';
      callId: string;
      name: string;
      category: ToolCategory;
      executor: ToolExecutor;
      input: unknown;
      runId?: string;
      /** Set when the call was made by a subagent; the subagent's own `tool.started` call id. */
      parentCallId?: string;
    }
  /** Incremental output while a tool runs, e.g. shell stdout. Appended, not replaced. */
  | { type: 'tool.output'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'tool.ended'; callId: string; result?: unknown; error?: string }
  | { type: 'interaction.requested'; interaction: PendingInteraction }
  | { type: 'interaction.resolved'; interactionId: string; response: InteractionResponse; resolvedBy?: string }
  | { type: 'interaction.cancelled'; interactionId: string; reason: string }
  | {
      type: 'usage';
      runId?: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      costUsd?: number;
    }
  | { type: 'model.changed'; runtimeId: string; modelId: string }
  | { type: 'error'; message: string; retryable: boolean; runId?: string };

export type FactoryEventType = FactoryEvent['type'];

/** A persisted event. `seq` is per-session, strictly increasing from 1, with no gaps. */
export interface EventEnvelope<E extends FactoryEvent = FactoryEvent> {
  sessionId: string;
  seq: number;
  /** ISO-8601 time the event was appended. */
  at: string;
  event: E;
}
