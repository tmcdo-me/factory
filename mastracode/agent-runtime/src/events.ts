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

/** Who wrote a message and where it came from. All optional; adapters fill what they know. */
export interface MessageMeta {
  author?: { id: string; name?: string; avatarUrl?: string };
  /** Set when the message arrived through a chat channel (Slack, …). */
  channel?: { platform: string; userId?: string; authorName?: string };
  /** Model that produced an assistant message. */
  modelId?: string;
  /** Credential the reply ran on, e.g. "Claude Pro/Max"; with `credentialOwnerId` for a personal one. */
  credentialLabel?: string;
  credentialOwnerId?: string;
  /** A user message sent while a run was active (steering). */
  steer?: boolean;
}

export interface MessageAttachment {
  name?: string;
  mediaType: string;
  /** URL or data URL. */
  url: string;
}

/** How a finished command exited, for tools in the `shell` category. */
export interface ToolExit {
  code: number;
  killed?: boolean;
  timedOut?: boolean;
  /** Why the command could not run or be observed (then `code` is -1). */
  error?: string;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-tense label while in progress, e.g. "Running tests". */
  activeTitle?: string;
}

export type FactoryEvent =
  /** `input` is absent when the runtime started the run itself or the adapter can't attribute it. */
  | { type: 'run.started'; runId: string; input?: TurnInput }
  | { type: 'run.ended'; runId: string; reason: RunEndReason; error?: string }
  | {
      type: 'message.started';
      messageId: string;
      role: 'assistant' | 'user';
      runId?: string;
      meta?: MessageMeta;
      attachments?: MessageAttachment[];
    }
  | { type: 'message.delta'; messageId: string; part: 'text' | 'reasoning'; delta: string }
  /** Metadata that only becomes known later (model, credential). Merged into the message's `meta`. */
  | { type: 'message.meta'; messageId: string; meta: MessageMeta }
  | { type: 'message.ended'; messageId: string }
  | {
      type: 'tool.started';
      callId: string;
      name: string;
      category: ToolCategory;
      executor: ToolExecutor;
      /** Absent while the model is still streaming the arguments; then `tool.input` follows. */
      input?: unknown;
      runId?: string;
      /** Set when the call was made by a subagent; the subagent's own `tool.started` call id. */
      parentCallId?: string;
    }
  /** Raw argument text as the model streams it. Appended. */
  | { type: 'tool.input.delta'; callId: string; delta: string }
  /** The parsed arguments, once complete. */
  | { type: 'tool.input'; callId: string; input: unknown }
  /** Incremental output while a tool runs, e.g. shell stdout. Appended, not replaced. */
  | { type: 'tool.output'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  /** A partial result a long-running tool reports before it ends. Replaces the previous one. */
  | { type: 'tool.progress'; callId: string; partial: unknown }
  /** `denied`: the human declined it, so it never ran. */
  | { type: 'tool.ended'; callId: string; result?: unknown; error?: string; exit?: ToolExit; denied?: boolean }
  | { type: 'interaction.requested'; interaction: PendingInteraction }
  | { type: 'interaction.resolved'; interactionId: string; response: InteractionResponse; resolvedBy?: string }
  | { type: 'interaction.cancelled'; interactionId: string; reason: string }
  /**
   * Context shown in the transcript that is neither a user nor an assistant message: a skill
   * activation, the session's environment, a cross-session notification, a reminder, a state
   * snapshot. `kind`/`tag` name it; `attributes` carries kind-specific fields.
   */
  | {
      type: 'notice';
      noticeId: string;
      kind: string;
      tag?: string;
      text: string;
      attributes?: Record<string, unknown>;
      runId?: string;
    }
  /** The agent's task list, replaced wholesale. */
  | { type: 'tasks.updated'; tasks: TaskSnapshot[] }
  /** A subagent the runtime started for a tool call (`callId`); its own tool calls carry `parentCallId`. */
  | { type: 'subagent.started'; callId: string; agentType: string; task: string; modelId?: string }
  | { type: 'subagent.ended'; callId: string; result?: string; error?: string }
  /**
   * Token usage, as the runtime reports it. `inputTokens`/`outputTokens` follow the runtime's own
   * report (one model step for Mastra Code, a whole turn for Claude Agent), so they don't compare
   * across runtimes; `contextTokens` and `contextWindow` do.
   */
  | {
      type: 'usage';
      runId?: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
      /**
       * Tokens in the main agent's context: the whole prompt of its latest model call (uncached,
       * cache-read and cache-written input together). A snapshot, not a running total; absent when
       * the runtime can't tell.
       */
      contextTokens?: number;
      /** Context window of the model that made that call, when the runtime reports one. */
      contextWindow?: number;
    }
  | { type: 'model.changed'; runtimeId: string; modelId: string }
  /** `code` names the failure (e.g. an error class or provider code) so the UI can offer a fix. */
  | {
      type: 'error';
      message: string;
      retryable: boolean;
      runId?: string;
      code?: string;
      details?: Record<string, unknown>;
    };

export type FactoryEventType = FactoryEvent['type'];

/** A persisted event. `seq` is per-session, strictly increasing from 1, with no gaps. */
export interface EventEnvelope<E extends FactoryEvent = FactoryEvent> {
  sessionId: string;
  seq: number;
  /** ISO-8601 time the event was appended. */
  at: string;
  event: E;
}
