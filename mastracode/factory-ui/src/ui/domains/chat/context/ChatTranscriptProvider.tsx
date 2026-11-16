import type { AgentControllerEvent } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent-controller';
import type { ReactNode } from 'react';
import { useContext, useEffect, useEffectEvent, useReducer } from 'react';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { chatSessionPhase } from '../../workspaces/services/sessionStatus';
import { useAgentControllerTranscript } from '../hooks/useAgentControllerTranscript';
import { useFactorySessionTranscript } from '../hooks/useFactorySessionTranscript';
import { useSessionRuntimeQuery, usesFactorySessionApi } from '../hooks/useSessionRuntime';
import { initialChatRuntime, runtimeReducer } from '../services/runtime';
import type { ContextUsage } from '../services/contextUsage';
import type { ChatRuntimeState, SessionStateSnapshot } from '../services/runtime';
import type { TranscriptState } from '../services/transcript';
import { SessionFavicon } from '../components/SessionFavicon';
import { ChatConnectionProvider } from './ChatConnectionProvider';
import { ChatRuntimeContext } from './ChatRuntimeContext';
import { ChatThreadMessagesContext } from './ChatThreadMessagesContext';
import { ChatTranscriptContext } from './ChatTranscriptContext';
import type { ChatTranscriptApi, LoadMoreHistory } from './ChatTranscriptContext';
import { useChatConnection } from './useChatConnection';
import { useChatMessagesError } from './useChatMessagesError';
import { useChatMessagesInitializing } from './useChatMessagesInitializing';
import { useChatSessionContext } from './useChatSessionContext';

// fork(claude-agent): a session is drawn from Factory's session event log when it runs on Claude
// Agent, or when the Factory transcript source is selected (thread id === session id). Each source is
// its own component, so a provider always calls the same hook.
type TranscriptProviderProps = Parameters<typeof MastraChatTranscriptProvider>[0];

export function ChatTranscriptProvider(props: TranscriptProviderProps) {
  const runtime = useSessionRuntimeQuery(props.threadId).data;
  return usesFactorySessionApi(runtime) ? (
    <FactoryChatTranscriptProvider {...props} />
  ) : (
    <MastraChatTranscriptProvider {...props} />
  );
}

const useFactoryTranscript: typeof useAgentControllerTranscript = ({ initialThreadId, viewerId } = {}) =>
  useFactorySessionTranscript({ sessionId: initialThreadId, viewerId });

const MastraChatTranscriptProvider = transcriptProviderUsing(useAgentControllerTranscript);
const FactoryChatTranscriptProvider = transcriptProviderUsing(useFactoryTranscript);

function transcriptProviderUsing(useTranscript: typeof useAgentControllerTranscript) {
  return function TranscriptProvider({
    children,
    threadId,
    initialMessages,
    hasMoreHistory = false,
    isLoadingMoreHistory = false,
    loadMoreHistory,
  }: {
    children: ReactNode;
    threadId?: string;
    initialMessages?: MastraDBMessage[];
    hasMoreHistory?: boolean;
    isLoadingMoreHistory?: boolean;
    loadMoreHistory?: () => void;
  }) {
    const viewerId = useFactoryAuth().data?.user?.userId;
    const transcriptApi = useTranscript({ initialThreadId: threadId, initialMessages, viewerId });
    const [runtime, dispatchRuntime] = useReducer(runtimeReducer, initialChatRuntime);
    const onEvent = (event: AgentControllerEvent) => {
      transcriptApi.onEvent(event);
      dispatchRuntime({ type: 'event', event });
    };
    const reset = (nextThreadId?: string, state?: SessionStateSnapshot) => {
      transcriptApi.reset(nextThreadId);
      dispatchRuntime({ type: 'reset', threadId: nextThreadId, state });
    };
    const mergeWindow = useEffectEvent((messages: MastraDBMessage[]) => transcriptApi.mergeWindow(messages));
    useEffect(() => {
      if (initialMessages === undefined) return;
      mergeWindow(initialMessages);
    }, [initialMessages]);

    const loadMore: LoadMoreHistory = {
      hasMore: hasMoreHistory,
      isLoading: isLoadingMoreHistory,
      load: loadMoreHistory,
    };

    return (
      <ChatConnectionProvider onEvent={onEvent}>
        <ChatRuntimeValueProvider
          runtime={runtime}
          threadId={transcriptApi.transcript.threadId ?? threadId}
          context={transcriptApi.transcript.context}
        >
          <ChatTranscriptValueProvider
            threadId={threadId}
            viewerId={viewerId}
            transcriptApi={transcriptApi}
            reset={reset}
            loadMore={loadMore}
          >
            {children}
          </ChatTranscriptValueProvider>
        </ChatRuntimeValueProvider>
      </ChatConnectionProvider>
    );
  };
}

function ChatRuntimeValueProvider({
  children,
  runtime,
  threadId,
  context,
}: {
  children: ReactNode;
  runtime: ChatRuntimeState;
  threadId?: string;
  /** fork(claude-agent): the context Factory's event log reports; wins over the Mastra stream's. */
  context?: ContextUsage;
}) {
  const { state } = useChatConnection();
  const sessionState = !threadId || state?.threadId === threadId ? state : undefined;
  return (
    <ChatRuntimeContext.Provider
      value={{
        usage: runtime.usage ?? sessionState?.tokenUsage,
        context: context ?? runtime.context,
        followUpCount: runtime.followUpCount,
        runsStarted: runtime.runsStarted,
        tokensPerSec: runtime.tokensPerSec,
      }}
    >
      {children}
    </ChatRuntimeContext.Provider>
  );
}

function ChatTranscriptValueProvider({
  children,
  threadId,
  viewerId,
  transcriptApi,
  reset,
  loadMore,
}: {
  children: ReactNode;
  threadId?: string;
  viewerId?: string;
  transcriptApi: ReturnType<typeof useAgentControllerTranscript>;
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
