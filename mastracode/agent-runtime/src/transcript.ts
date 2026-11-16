import type { EventEnvelope, RunEndReason, ToolCategory, ToolExecutor } from './events';
import type { InteractionResponse, InteractionStatus, PendingInteraction } from './interactions';
import type { TurnInput } from './runtime';

/**
 * The session transcript, derived purely from the event log. Server (board rules, audits) and UI
 * use the same reducer, so they can never disagree about what happened.
 */
export interface Transcript {
  sessionId: string;
  /** `seq` of the last applied event; 0 when empty. */
  lastSeq: number;
  items: TranscriptItem[];
}

export type TranscriptItem = RunItem | MessageItem | ToolItem | InteractionItem | ErrorItem;

export interface RunItem {
  kind: 'run';
  runId: string;
  input: TurnInput;
  status: 'running' | RunEndReason;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

export interface MessageItem {
  kind: 'message';
  messageId: string;
  role: 'assistant' | 'user';
  runId?: string;
  /** Consecutive deltas of the same part type are merged into one part. */
  parts: { type: 'text' | 'reasoning'; text: string }[];
  complete: boolean;
  startedAt: string;
}

export interface ToolItem {
  kind: 'tool';
  callId: string;
  name: string;
  category: ToolCategory;
  executor: ToolExecutor;
  input: unknown;
  runId?: string;
  parentCallId?: string;
  status: 'running' | 'done' | 'error';
  stdout: string;
  stderr: string;
  result?: unknown;
  error?: string;
  startedAt: string;
  endedAt?: string;
  /** `seq` of the `tool.ended` event; lets callers process results incrementally. */
  endedSeq?: number;
}

export interface InteractionItem {
  kind: 'interaction';
  interaction: PendingInteraction;
  status: InteractionStatus;
  response?: InteractionResponse;
  resolvedBy?: string;
  cancelReason?: string;
}

export interface ErrorItem {
  kind: 'error';
  message: string;
  retryable: boolean;
  runId?: string;
  at: string;
}

export function emptyTranscript(sessionId: string): Transcript {
  return { sessionId, lastSeq: 0, items: [] };
}

export function buildTranscript(sessionId: string, envelopes: Iterable<EventEnvelope>): Transcript {
  let transcript = emptyTranscript(sessionId);
  for (const envelope of envelopes) transcript = applyEvent(transcript, envelope);
  return transcript;
}

/**
 * Apply one event. Returns a new transcript; untouched items keep their identity, so UI memoization
 * works. Events at or below `lastSeq` are ignored, which makes replay after reconnect safe.
 */
export function applyEvent(transcript: Transcript, envelope: EventEnvelope): Transcript {
  if (envelope.seq <= transcript.lastSeq) return transcript;
  const items = apply(transcript.items, envelope);
  return { sessionId: transcript.sessionId, lastSeq: envelope.seq, items };
}

function apply(items: TranscriptItem[], { event, at, seq }: EventEnvelope): TranscriptItem[] {
  switch (event.type) {
    case 'run.started':
      return [...items, { kind: 'run', runId: event.runId, input: event.input, status: 'running', startedAt: at }];
    case 'run.ended':
      return update(items, isRun(event.runId), run => ({
        ...run,
        status: event.reason,
        error: event.error,
        endedAt: at,
      }));
    case 'message.started':
      return [
        ...items,
        {
          kind: 'message',
          messageId: event.messageId,
          role: event.role,
          runId: event.runId,
          parts: [],
          complete: false,
          startedAt: at,
        },
      ];
    case 'message.delta':
      return update(items, isMessage(event.messageId), message => {
        const last = message.parts.at(-1);
        const parts =
          last && last.type === event.part
            ? [...message.parts.slice(0, -1), { type: last.type, text: last.text + event.delta }]
            : [...message.parts, { type: event.part, text: event.delta }];
        return { ...message, parts };
      });
    case 'message.ended':
      return update(items, isMessage(event.messageId), message => ({ ...message, complete: true }));
    case 'tool.started':
      return [
        ...items,
        {
          kind: 'tool',
          callId: event.callId,
          name: event.name,
          category: event.category,
          executor: event.executor,
          input: event.input,
          runId: event.runId,
          parentCallId: event.parentCallId,
          status: 'running',
          stdout: '',
          stderr: '',
          startedAt: at,
        },
      ];
    case 'tool.output':
      return update(items, isTool(event.callId), tool =>
        event.stream === 'stdout'
          ? { ...tool, stdout: tool.stdout + event.chunk }
          : { ...tool, stderr: tool.stderr + event.chunk },
      );
    case 'tool.ended':
      return update(items, isTool(event.callId), tool => ({
        ...tool,
        status: event.error === undefined ? 'done' : 'error',
        result: event.result,
        error: event.error,
        endedAt: at,
        endedSeq: seq,
      }));
    case 'interaction.requested':
      return [...items, { kind: 'interaction', interaction: event.interaction, status: 'pending' }];
    case 'interaction.resolved':
      return update(items, isInteraction(event.interactionId), item => ({
        ...item,
        status: 'resolved',
        response: event.response,
        resolvedBy: event.resolvedBy,
      }));
    case 'interaction.cancelled':
      return update(items, isInteraction(event.interactionId), item => ({
        ...item,
        status: 'cancelled',
        cancelReason: event.reason,
      }));
    case 'error':
      return [...items, { kind: 'error', message: event.message, retryable: event.retryable, runId: event.runId, at }];
    case 'usage':
    case 'model.changed':
      return items;
  }
}

/** Replace the last item matching `match` (events refer to recent items, so search from the end). */
function update<T extends TranscriptItem>(
  items: TranscriptItem[],
  match: (item: TranscriptItem) => item is T,
  change: (item: T) => T,
): TranscriptItem[] {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (match(item)) {
      const next = items.slice();
      next[index] = change(item);
      return next;
    }
  }
  return items; // event for an unknown item: ignore rather than corrupt the transcript
}

const isRun =
  (runId: string) =>
  (item: TranscriptItem): item is RunItem =>
    item.kind === 'run' && item.runId === runId;
const isMessage =
  (messageId: string) =>
  (item: TranscriptItem): item is MessageItem =>
    item.kind === 'message' && item.messageId === messageId;
const isTool =
  (callId: string) =>
  (item: TranscriptItem): item is ToolItem =>
    item.kind === 'tool' && item.callId === callId;
const isInteraction =
  (interactionId: string) =>
  (item: TranscriptItem): item is InteractionItem =>
    item.kind === 'interaction' && item.interaction.id === interactionId;

/** Finished tool calls, e.g. Factory tool results for board rules. */
export function finishedToolCalls(
  transcript: Transcript,
  filter: { executor?: ToolExecutor; name?: string; afterSeq?: number } = {},
): ToolItem[] {
  return transcript.items.filter(
    (item): item is ToolItem =>
      item.kind === 'tool' &&
      item.status !== 'running' &&
      (filter.executor === undefined || item.executor === filter.executor) &&
      (filter.name === undefined || item.name === filter.name) &&
      (filter.afterSeq === undefined || (item.endedSeq ?? 0) > filter.afterSeq),
  );
}
