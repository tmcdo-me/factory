// fork(claude-agent): sessions waiting on a person, read from Factory's attention inbox and answered from outside them.
import type { InteractionRequest } from '@factory/agent-runtime/browser';

import type { FactoryAttentionTarget } from './attention';
import { requestJson } from './request';

/** The call a waiting session is parked on and what it asks; absent when it can only be answered in the session. */
export interface FactoryWaitingInteraction {
  /** The tool call that asked; absent for a question a run's turn ended on in plain text. */
  toolCallId?: string;
  /** The interaction broker's id (Claude Agent sessions). */
  interactionId?: string;
  request: InteractionRequest;
}

/** One `agent-waiting` item of `/web/factory/projects/:id/attention`: a card's session parked on a person. */
export interface FactoryWaitingItem {
  key: string;
  kind: 'agent-waiting';
  sessionId: string;
  threadId: string;
  role: string;
  toolName: string;
  occurrence: number;
  workItemId: string;
  title: string;
  detail: string;
  occurredAt: string;
  read: boolean;
  archived: boolean;
  target: Extract<FactoryAttentionTarget, { kind: 'thread' }>;
  interaction?: FactoryWaitingInteraction;
}

/**
 * One `automation-proposed` item: a run or move the board's rules composed and left for a person to
 * release. Who may approve is the server's call (a move held for consent takes an org admin).
 */
export interface FactoryProposalItem {
  key: string;
  kind: 'automation-proposed';
  decisionId: string;
  decisionType: string;
  occurrence: number;
  workItemId: string | null;
  title: string;
  detail: string;
  occurredAt: string;
  read: boolean;
  archived: boolean;
  target: FactoryAttentionTarget;
}

export type FactoryInboxItem = FactoryWaitingItem | FactoryProposalItem;

export interface FactoryWaitingPage {
  items: FactoryInboxItem[];
  hasMore: boolean;
  nextCursor?: string;
}

/** The most the page lists at once; the server caps a page at this too. */
export const WAITING_LIMIT = 50;

/** The open items of a Factory that wait on a person (sessions and proposals), newest first. */
export function fetchWaitingSessions(
  baseUrl: string,
  factoryProjectId: string,
  signal?: AbortSignal,
): Promise<FactoryWaitingPage> {
  const query = new URLSearchParams([
    ['kind', 'agent-waiting'],
    ['kind', 'automation-proposed'],
    ['view', 'open'],
    ['limit', String(WAITING_LIMIT)],
  ]);
  return requestJson<FactoryWaitingPage>(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/attention?${query}`,
    { signal },
  );
}

/** Answer the question (ask_user) a session waits on. Its owner, an admin, or anyone following its card may. */
export async function answerWaitingQuestion(
  baseUrl: string,
  sessionId: string,
  question: { toolCallId?: string; interactionId?: string },
  answer: string | string[],
): Promise<void> {
  await requestJson(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}/parked-question`, {
    method: 'POST',
    body: JSON.stringify({
      answer,
      ...(question.toolCallId ? { toolCallId: question.toolCallId } : {}),
      ...(!question.toolCallId && question.interactionId ? { interactionId: question.interactionId } : {}),
    }),
  });
}

/** Approve or decline the plan (or other call) a session waits on; a decline's reason reaches the session. */
export async function answerWaitingDecision(
  baseUrl: string,
  sessionId: string,
  toolCallId: string,
  decision: 'approve' | 'decline',
  reason?: string,
): Promise<void> {
  await requestJson(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}/parked-approval`, {
    method: 'POST',
    body: JSON.stringify({ decision, toolCallId, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  });
}
