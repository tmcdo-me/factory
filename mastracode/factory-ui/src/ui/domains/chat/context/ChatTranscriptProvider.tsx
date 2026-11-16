import type { AgentControllerEvent } from '@mastra/client-js';
import { isKnownAgentControllerEvent } from '@mastra/client-js';
import { normalizeSessionTitle } from '@mastra/factory/session/session-title';
import type { MastraDBMessage } from '@mastra/core/agent-controller';
import type { ReactNode } from 'react';
import { useCallback, useContext, useEffect, useEffectEvent, useMemo, useReducer, useState } from 'react';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { chatSessionPhase } from '../../workspaces/services/sessionStatus';
import { useAgentControllerTranscript } from '../hooks/useAgentControllerTranscript';
import { useFactorySessionTranscript } from '../hooks/useFactorySessionTranscript';
import { sessionTranscriptSource, useSessionRuntimeQuery } from '../hooks/useSessionRuntime';
import { initialChatRuntime, runtimeReducer } from '../services/runtime';
import type { SessionStateSnapshot } from '../services/runtime';
import type { TranscriptState } from '../services/transcript';
import { SessionFavicon } from '../components/SessionFavicon';
import { ChatConnectionContext } from './ChatConnectionContext';
import { useFactoryChatConnection, useMastraChatConnection } from './ChatConnectionProvider';
import { ChatRuntimeContext } from './ChatRuntimeContext';
import type { ChatRuntimeApi } from './ChatRuntimeContext';
import { ChatThreadMessagesContext } from './ChatThreadMessagesContext';
import { ChatTranscriptContext } from './ChatTranscriptContext';
import type { ChatTranscriptApi, LoadMoreHistory } from './ChatTranscriptContext';
import { useChatConnection } from './useChatConnection';
import { useChatMessagesError } from './useChatMessagesError';
import { useChatMessagesInitializing } from './useChatMessagesInitializing';
import { useChatSessionContext } from './useChatSessionContext';

// fork(claude-agent): every session is drawn from Factory's session event log, whatever its runtime,
// with its runtime state (running, usage, context) read from the same log. A Mastra Code session
// whose conversation began before Factory logged its events is drawn from Mastra memory and its
// agent-controller stream instead (the server says which). Both sources' hooks are always called and
// only the one in use is enabled, so learning the source never remounts the chat (a draft typed
// while the session loads survives).
interface TranscriptProviderProps {
  children: ReactNode;
  threadId?: string;
  initialMessages?: MastraDBMessage[];
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  loadMoreHistory?: () => void;
}

export function ChatTranscriptProvider({
  children,
  threadId,
  initialMessages,
  hasMoreHistory = false,
  isLoadingMoreHistory = false,
  loadMoreHistory,
}: TranscriptProviderProps) {
  const viewerId = useFactoryAuth().data?.user?.userId;
  const runtimeQuery = useSessionRuntimeQuery(threadId);
  // Until the server says where a session's history lives, neither source reads it.
  const source = sessionTranscriptSource(threadId, runtimeQuery);
  const fromMastra = source === 'mastra';
  const fromFactory = source === 'factory';

  const factoryApi = useFactorySessionTranscript({ sessionId: fromFactory ? threadId : undefined, viewerId });
  const factoryConnection = useFactoryChatConnection({
    sessionId: threadId,
    status: factoryApi.connection,
    running: factoryApi.running,
    enabled: fromFactory,
  });
  const { usage: factoryUsage } = factoryApi;
  const factoryRuntime = useMemo<ChatRuntimeApi>(
    () => ({
      usage: factoryUsage && {
        promptTokens: factoryUsage.inputTokens,
        completionTokens: factoryUsage.outputTokens,
        totalTokens: factoryUsage.inputTokens + factoryUsage.outputTokens,
      },
      context: factoryApi.transcript.context,
      // Mastra's queued follow-ups and decode rate have no counterpart in the event log.
      followUpCount: 0,
      runsStarted: factoryApi.runsStarted,
      tokensPerSec: 0,
    }),
    [factoryUsage, factoryApi.transcript.context, factoryApi.runsStarted],
  );

  const mastraApi = useAgentControllerTranscript({ initialThreadId: threadId, initialMessages, viewerId });
  const [mastraRuntimeState, dispatchRuntime] = useReducer(runtimeReducer, initialChatRuntime);
  // fork(claude-agent): the name Mastra gives the session's conversation, which Factory also writes
  // onto the session row (a session is one conversation: its thread id is its id).
  const [namedTitle, setNamedTitle] = useState<string>();
  const mastraConnection = useMastraChatConnection(event => {
    mastraApi.onEvent(event);
    dispatchRuntime({ type: 'event', event });
    const named = conversationTitle(event, threadId);
    if (named) setNamedTitle(named);
  }, fromMastra);
  const mergeWindow = useEffectEvent((messages: MastraDBMessage[]) => mastraApi.mergeWindow(messages));
  useEffect(() => {
    if (initialMessages === undefined) return;
    mergeWindow(initialMessages);
  }, [initialMessages]);
  const mastraThreadId = mastraApi.transcript.threadId ?? threadId;
  const mastraSessionState =
    !mastraThreadId || mastraConnection.state?.threadId === mastraThreadId ? mastraConnection.state : undefined;
  const mastraRuntime: ChatRuntimeApi = {
    usage: mastraRuntimeState.usage ?? mastraSessionState?.tokenUsage,
    context: mastraRuntimeState.context,
    followUpCount: mastraRuntimeState.followUpCount,
    runsStarted: mastraRuntimeState.runsStarted,
    tokensPerSec: mastraRuntimeState.tokensPerSec,
  };
  const mastraReset = (nextThreadId?: string, state?: SessionStateSnapshot) => {
    mastraApi.reset(nextThreadId);
    dispatchRuntime({ type: 'reset', threadId: nextThreadId, state });
  };
  // A session whose source is still unknown has no history yet, not an empty one.
  const factoryTranscriptApi = fromFactory || !threadId ? factoryApi : { ...factoryApi, initialHistoryReady: false };
  const factoryReset = useCallback((_threadId?: string, _state?: SessionStateSnapshot) => {}, []);

  return (
    <ChatConnectionContext.Provider value={fromMastra ? mastraConnection : factoryConnection}>
      <ChatRuntimeContext.Provider value={fromMastra ? mastraRuntime : factoryRuntime}>
        <ChatTranscriptValueProvider
          threadId={threadId}
          viewerId={viewerId}
          transcriptApi={fromMastra ? mastraApi : factoryTranscriptApi}
          title={fromMastra ? namedTitle : undefined}
          reset={fromMastra ? mastraReset : factoryReset}
          loadMore={
            fromMastra ? { hasMore: hasMoreHistory, isLoading: isLoadingMoreHistory, load: loadMoreHistory } : NO_MORE
          }
        >
          {children}
        </ChatTranscriptValueProvider>
      </ChatRuntimeContext.Provider>
    </ChatConnectionContext.Provider>
  );
}

const NO_MORE: LoadMoreHistory = { hasMore: false, isLoading: false };

function ChatTranscriptValueProvider({
  children,
  threadId,
  viewerId,
  transcriptApi,
  title,
  reset,
  loadMore,
}: {
  children: ReactNode;
  threadId?: string;
  viewerId?: string;
  /** fork(claude-agent): a name the session got while open, when its transcript doesn't carry it. */
  title?: string;
  transcriptApi: Pick<
    ReturnType<typeof useAgentControllerTranscript>,
    | 'transcript'
    | 'initialHistoryReady'
    | 'localUser'
    | 'failLocalUser'
    | 'resolvePrompt'
    | 'clearPending'
    | 'pushNotice'
  >;
  reset: ChatTranscriptApi['reset'];
  loadMore: LoadMoreHistory;
}) {
  const connection = useChatConnection();
  const { sessionError, sandboxPreparing } = useChatSessionContext();
  const messagesThreadId = useContext(ChatThreadMessagesContext)?.threadId;
  const messagesInitializing = useChatMessagesInitializing();
  const messagesError = useChatMessagesError();
  const { transcript, initialHistoryReady, localUser, failLocalUser, resolvePrompt, clearPending, pushNotice } =
    transcriptApi;
  const effectiveThreadId = transcript.threadId ?? threadId ?? connection.createdThreadId;

  const effectiveTranscript: TranscriptState = {
    ...transcript,
    threadId: effectiveThreadId,
    tasks: connection.state?.tasks ?? transcript.tasks,
    ...((transcript.title ?? title) ? { title: transcript.title ?? title } : {}),
  };
  const busy = connection.state?.running === true || effectiveTranscript.pending;
  const historyInitializing = Boolean(messagesThreadId) && !messagesError && !initialHistoryReady;
  const initializing = sandboxPreparing || messagesInitializing || historyInitializing;
  const phase = chatSessionPhase({
    sessionError: Boolean(sessionError),
    threadError: messagesError || connection.status === 'error',
    hasThread: Boolean(effectiveThreadId),
    running: connection.state?.running === true,
    initializing,
    pending: effectiveTranscript.pending,
  });
  const transcriptValue: ChatTranscriptApi = {
    transcript: effectiveTranscript,
    viewerId,
    busy,
    phase,
    initializing,
    historyInitializing,
    initialHistoryReady,
    localUser,
    failLocalUser,
    reset,
    resolvePrompt,
    clearPending,
    pushNotice,
    loadMore,
  };

  return (
    <ChatTranscriptContext.Provider value={transcriptValue}>
      <SessionFavicon state={phase} />
      {children}
    </ChatTranscriptContext.Provider>
  );
}

/** fork(claude-agent): the title a Mastra event gives the session's own conversation, as the session row stores it. */
function conversationTitle(event: AgentControllerEvent, threadId: string | undefined): string | undefined {
  if (!threadId || !isKnownAgentControllerEvent(event)) return undefined;
  const raw =
    event.type === 'thread_title_updated'
      ? event.threadId === threadId && event.title
      : event.type === 'om_thread_title_updated'
        ? event.threadId === threadId && event.newTitle
        : undefined;
  return raw ? (normalizeSessionTitle(raw) ?? undefined) : undefined;
}
