// fork(claude-agent): a session's writes go through Factory's session API, whatever runtime runs it.
import type { ThinkingLevel } from '@factory/agent-runtime/browser';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import { AGENT_CONTROLLER_ID } from '../ui/domains/chat/services/constants';
import {
  abortFactorySession,
  approveFactorySessionTool,
  respondToFactorySessionPrompt,
  sendFactorySessionMessage,
  switchFactorySessionModel,
} from '../ui/domains/chat/services/factorySessionCommands';
import type { CommandAck, PromptReply } from '../ui/domains/chat/services/factorySessionCommands';

export interface SessionCommandArgs {
  sessionId: string;
  baseUrl?: string;
}

export interface SendSessionMessageInput {
  text: string;
  /** Base64-encoded attachments (e.g. pasted images). */
  files?: Array<{ data: string; mediaType: string; filename?: string }>;
}

export function useSendSessionMessageMutation({ sessionId, baseUrl = '' }: SessionCommandArgs) {
  return useMutation({
    mutationFn: (input: SendSessionMessageInput | string) =>
      sendFactorySessionMessage(baseUrl, sessionId, typeof input === 'string' ? { text: input } : input),
  });
}

export function useAbortSessionMutation({ sessionId, baseUrl = '' }: SessionCommandArgs) {
  return useMutation({ mutationFn: () => abortFactorySession(baseUrl, sessionId) });
}

export function useApproveSessionToolMutation({ sessionId, baseUrl = '' }: SessionCommandArgs) {
  return useMutation({
    mutationFn: ({ toolCallId, approved }: { toolCallId: string; approved: boolean }) =>
      approveFactorySessionTool(baseUrl, sessionId, toolCallId, approved).then(requireAccepted),
    onError: reportRejectedReply,
  });
}

export function useRespondSessionPromptMutation({ sessionId, baseUrl = '' }: SessionCommandArgs) {
  return useMutation({
    mutationFn: ({ toolCallId, resumeData }: { toolCallId: string; resumeData: PromptReply }) =>
      respondToFactorySessionPrompt(baseUrl, sessionId, toolCallId, resumeData).then(requireAccepted),
    onError: reportRejectedReply,
  });
}

interface ModelSwitch {
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export function useSwitchSessionModelMutation({ sessionId, baseUrl = '' }: SessionCommandArgs) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ modelId, thinkingLevel }: ModelSwitch) =>
      switchFactorySessionModel(baseUrl, sessionId, modelId, thinkingLevel),
    // The session's model and thinking level are still read from its live state.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(AGENT_CONTROLLER_ID, sessionId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerSettings(AGENT_CONTROLLER_ID, sessionId),
          exact: true,
        }),
      ]),
  });
}

export class RejectedReplyError extends Error {
  constructor(readonly reason: string | undefined) {
    super(
      reason === 'no_pending_suspension'
        ? 'This request is no longer waiting for a reply. Its run has ended.'
        : 'Your reply was not delivered. Someone may have already answered it.',
    );
  }
}

/** True when nothing will ever answer the prompt, so its card should go. */
export function isEndedPrompt(error: unknown): boolean {
  return error instanceof RejectedReplyError && error.reason === 'no_pending_suspension';
}

/** The server answers a reply it can't deliver with 409 and the runtime's reason. */
function requireAccepted(ack: CommandAck): CommandAck {
  if (ack.ok) return ack;
  throw new RejectedReplyError(ack.reason);
}

function reportRejectedReply(error: Error) {
  toast.error(error.message, { id: 'session-reply-rejected' });
}
