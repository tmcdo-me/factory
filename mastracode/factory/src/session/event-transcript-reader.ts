// fork(claude-agent): slice 7. The board's tool-result reconcile reads Factory's transcript (the session event
// log), not Mastra's memory: finished tool calls of the bound thread's runs, shaped as the assistant messages the
// processor already reads (the assistant message the call was made in, else the call id).
import type { EventEnvelope } from '@factory/agent-runtime';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';

export interface EventLogReader {
  list(sessionId: string, options?: { afterSeq?: number; limit?: number }): Promise<EventEnvelope[]>;
}

const PAGE = 1000;

interface OpenCall {
  name: string;
  input: unknown;
}

/**
 * The tool calls of one session that finished at or after `start` while the session was on `threadId`
 * (a run names its thread on `run.started`; runs from before it did are not read), oldest first.
 * A call denied or stopped before it ran is not a result.
 */
export async function listFinishedToolCalls(
  log: EventLogReader,
  input: { sessionId: string; threadId: string; start?: Date },
): Promise<MastraDBMessage[]> {
  const open = new Map<string, OpenCall>();
  const out: MastraDBMessage[] = [];
  // Finished calls that no assistant message has been seen for yet: Mastra announces the message
  // holding a call's result after the call starts, so it names the next assistant message of the run.
  let unassigned: Array<{ call: OpenCall; callId: string; at: string; error?: string; result?: unknown }> = [];
  let threadId: string | undefined;
  // The assistant message streaming now, if any: it holds the calls that finish while it is open.
  let openAssistant: string | undefined;
  let afterSeq = 0;
  const emit = (held: (typeof unassigned)[number], messageId: string) => {
    const createdAt = new Date(held.at);
    if (input.start && createdAt < input.start) return;
    const failed = held.error !== undefined;
    out.push({
      id: messageId,
      role: 'assistant',
      createdAt,
      content: {
        format: 2,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: failed ? 'error' : 'result',
              toolCallId: held.callId,
              toolName: held.call.name,
              args: held.call.input ?? {},
              ...(failed ? { error: held.error } : { result: held.result }),
            },
          },
        ],
      },
    } as MastraDBMessage);
  };
  const flush = () => {
    for (const held of unassigned) emit(held, held.callId);
    unassigned = [];
  };
  for (;;) {
    const page = await log.list(input.sessionId, { afterSeq, limit: PAGE });
    for (const { seq, at, event } of page) {
      afterSeq = Math.max(afterSeq, seq);
      switch (event.type) {
        case 'run.started':
          flush();
          openAssistant = undefined;
          threadId = event.threadId;
          break;
        case 'run.ended':
          flush();
          break;
        case 'message.started':
          if (event.role === 'assistant') {
            for (const held of unassigned) emit(held, event.messageId);
            unassigned = [];
            openAssistant = event.messageId;
          }
          break;
        case 'message.ended':
          if (event.messageId === openAssistant) openAssistant = undefined;
          break;
        case 'tool.started':
          open.set(event.callId, { name: event.name, input: event.input });
          break;
        case 'tool.input': {
          const call = open.get(event.callId);
          if (call) call.input = event.input;
          break;
        }
        case 'tool.ended': {
          const call = open.get(event.callId);
          open.delete(event.callId);
          if (!call || threadId !== input.threadId || event.denied || event.stopped) break;
          const held = {
            call,
            callId: event.callId,
            at,
            ...(event.error !== undefined ? { error: event.error } : { result: event.result }),
          };
          if (openAssistant) emit(held, openAssistant);
          else unassigned.push(held);
          break;
        }
        default:
          break;
      }
    }
    if (page.length < PAGE) break;
  }
  flush();
  return out;
}

/** A message reader (the processor's) over the event log, for the bound thread of one session. */
export function eventTranscriptReader(log: EventLogReader) {
  return {
    async listMessages(input: {
      threadId: string;
      sessionId?: string;
      page: number;
      perPage: number;
      filter?: { dateRange?: { start?: Date } };
    }): Promise<{ messages: MastraDBMessage[]; hasMore: boolean }> {
      if (!input.sessionId) return { messages: [], hasMore: false };
      const finished = await listFinishedToolCalls(log, {
        sessionId: input.sessionId,
        threadId: input.threadId,
        ...(input.filter?.dateRange?.start ? { start: input.filter.dateRange.start } : {}),
      });
      const from = input.page * input.perPage;
      return { messages: finished.slice(from, from + input.perPage), hasMore: from + input.perPage < finished.length };
    },
  };
}
