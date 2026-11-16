// fork(claude-agent): the sessions waiting on a person, and answering them from outside the session.
import { toast } from '@mastra/playground-ui/components/Toaster';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { actOnFactoryDecision } from '../services/decisions';
import { answerWaitingDecision, answerWaitingQuestion, fetchWaitingSessions } from '../services/waiting';
import type { FactoryInboxItem } from '../services/waiting';

/** Without the feed stream, how often the list is read again. */
const WAITING_POLL_MS = 10_000;

/** What waits on a person in a Factory: card sessions (a question, a plan) and proposals, newest first. */
export function useWaitingSessions(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.waitingSessions(factoryProjectId),
    queryFn: factoryProjectId ? ({ signal }) => fetchWaitingSessions(baseUrl, factoryProjectId, signal) : skipToken,
    select: page => page.items,
    refetchInterval: WAITING_POLL_MS,
  });
}

/** What a person sends back: an answer to a question, or a decision on a plan or another call. */
export type WaitingAnswer =
  | { kind: 'question'; answer: string | string[] }
  | { kind: 'decision'; decision: 'approve' | 'decline'; reason?: string };

/** Answers one waiting session, then reads the list (and the board) again. */
export function useAnswerWaitingSession(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['answer-waiting-session', factoryProjectId ?? null],
    mutationFn: async ({ item, answer }: { item: FactoryInboxItem; answer: WaitingAnswer }) => {
      if (item.kind === 'automation-proposed') {
        if (answer.kind !== 'decision' || !factoryProjectId) throw new Error('Approve or dismiss the proposal.');
        await actOnFactoryDecision(
          baseUrl,
          factoryProjectId,
          item.decisionId,
          answer.decision === 'approve' ? 'approve' : 'dismiss',
        );
        return;
      }
      const interaction = item.interaction;
      if (!interaction) throw new Error('Open the session to answer it.');
      if (answer.kind === 'question') {
        await answerWaitingQuestion(baseUrl, item.sessionId, interaction, answer.answer);
        return;
      }
      if (!interaction.toolCallId) throw new Error('Open the session to answer it.');
      await answerWaitingDecision(baseUrl, item.sessionId, interaction.toolCallId, answer.decision, answer.reason);
    },
    onSuccess: (_, { item, answer }) => {
      toast(
        answer.kind === 'question'
          ? 'Answer sent'
          : answer.decision === 'approve'
            ? 'Approved'
            : item.kind === 'automation-proposed'
              ? 'Dismissed'
              : 'Declined',
      );
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'Failed to answer'),
    // Answered or not (someone else may have got there first), the list is read again.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workItems(factoryProjectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.factoryDecisionsRoot(factoryProjectId) }),
      ]),
  });
}
