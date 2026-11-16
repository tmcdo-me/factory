import type { AgentControllerEvent } from '@mastra/client-js';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { queryKeys } from '../../../../api/keys';
import { useAgentControllerConnection } from '../hooks/useAgentControllerConnection';
import type { ConnectionStatus } from '../hooks/useAgentControllerConnection';
import { useSessionRuntimeQuery } from '../hooks/useSessionRuntime';
import { createAgentControllerClient } from '../services/agentControllerClient';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { CLAUDE_AGENT_RUNTIME } from '../services/factoryRuntimes';
import { ChatConnectionContext } from './ChatConnectionContext';
import type { ChatConnectionApi } from './ChatConnectionContext';
import { useChatSessionContext } from './useChatSessionContext';

/**
 * fork(claude-agent): the connection of a session drawn from Factory's event log. Whether it is
 * connected and running come from Factory's session stream, for every runtime; Mastra's
 * agent-controller session is neither created nor streamed. A Mastra Code session's model is the
 * one thing still read from Mastra, where its model and thinking settings live.
 */
export function useFactoryChatConnection({
  sessionId,
  status,
  running,
  enabled,
}: {
  sessionId?: string;
  status: ConnectionStatus;
  running: boolean;
  enabled: boolean;
}): ChatConnectionApi {
  const { resourceReady, baseUrl } = useChatSessionContext();
  const runtime = useSessionRuntimeQuery(sessionId).data;
  const mastraCode =
    enabled && Boolean(sessionId) && runtime !== undefined && runtime.runtimeId !== CLAUDE_AGENT_RUNTIME;
  const { session } = createAgentControllerClient({
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId: sessionId ?? '',
    baseUrl,
    enabled: mastraCode && resourceReady,
  });
  // Same key as the Mastra connection's state, so a model switch refreshes it.
  const mastraState = useQuery({
    queryKey: queryKeys.agentControllerConnectionState(AGENT_CONTROLLER_ID, sessionId ?? ''),
    queryFn: () => session!.state(),
    enabled: mastraCode && resourceReady && Boolean(session),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // A read that failed is tried again, so the model picker doesn't stay blank.
    refetchInterval: query => (query.state.status === 'error' ? 5_000 : false),
  });
  const modelId = runtime?.runtimeId === CLAUDE_AGENT_RUNTIME ? runtime.modelId : mastraState.data?.modelId;

  return {
    status: sessionId ? status : 'connecting',
    state: sessionId ? { threadId: sessionId, running, ...(modelId ? { modelId } : {}) } : undefined,
    threadId: sessionId,
    createdThreadId: sessionId,
  };
}

/** The connection of a session drawn from Mastra memory: its agent-controller session and stream. */
export function useMastraChatConnection(
  onEvent: (event: AgentControllerEvent) => void,
  enabled = true,
): ChatConnectionApi {
  const { sessionId, resourceId, threadTags, sessionThreadId, factorySessionState, resourceReady, baseUrl } =
    useChatSessionContext();
  const connection = useAgentControllerConnection({
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    resourceId,
    threadTags,
    sessionThreadId,
    factorySessionState,
    baseUrl,
    // Open the SSE stream + init the session as soon as the resource is
    // addressable, so transcript history and live events start streaming
    // without waiting on a sandbox. This includes `POST /sessions` (session
    // create) and `PUT /state` (state seed) — writes fired before any sandbox
    // exists. MSW proves the UI stays quiet on this path; the
    // real server acceptance was NOT validated by a runtime spot-check in
    // Phase 1 (see `.mastracode/plans/factory-session-eager-render.progress.md`).
    // If the runtime spot-check surfaces a red server-error notice from
    // early session-init, revert this single line back to `sessionEnabled`;
    // the rest of the eager-render split still delivers the win.
    enabled: enabled && resourceReady,
    onEvent,
  });

  return {
    status: connection.status,
    state: connection.state,
    threadId: connection.threadId,
    createdThreadId: connection.threadId,
  };
}

export function ChatConnectionProvider({
  children,
  onEvent,
}: {
  children: ReactNode;
  onEvent: (event: AgentControllerEvent) => void;
}) {
  const connection = useMastraChatConnection(onEvent);
  return <ChatConnectionContext.Provider value={connection}>{children}</ChatConnectionContext.Provider>;
}
