import type { EventLog } from '@factory/agent-runtime';

/** The Mastra Code conversation store a session's history lives in (an `AgentController`). */
export interface ConversationReader {
  queryThreadById(input: { threadId: string }): Promise<{ resourceId?: string } | null>;
  queryThreadMessages(input: {
    threadId: string;
    resourceId?: string;
    perPage: number;
    page: number;
    orderBy: { field: 'createdAt'; direction: 'ASC' };
  }): Promise<{ messages: { createdAt?: Date | string }[] }>;
}

/**
 * How much earlier than the first logged event a session's first stored message may be and still
 * count as the same turn: Mastra stores the prompt a moment before the run's events are appended.
 */
export const LOGGED_HISTORY_SLACK_MS = 60_000;

/**
 * Whether a Mastra Code session's conversation started before Factory's event log recorded it (it
 * ran before sessions were mirrored), so the log alone would show it without its beginning. The
 * session's conversation is its own thread (thread id === session id).
 */
export async function historyPredatesEventLog({
  conversation,
  events,
  sessionId,
}: {
  conversation: ConversationReader;
  events: Pick<EventLog, 'list'>;
  sessionId: string;
}): Promise<boolean> {
  const thread = await conversation.queryThreadById({ threadId: sessionId });
  if (!thread) return false;
  const { messages } = await conversation.queryThreadMessages({
    threadId: sessionId,
    ...(thread.resourceId ? { resourceId: thread.resourceId } : {}),
    perPage: 1,
    page: 0,
    orderBy: { field: 'createdAt', direction: 'ASC' },
  });
  const oldest = messages[0]?.createdAt;
  if (oldest === undefined) return false;
  const [first] = await events.list(sessionId, { limit: 1 });
  if (!first) return true;
  return new Date(oldest).getTime() < Date.parse(first.at) - LOGGED_HISTORY_SLACK_MS;
}
