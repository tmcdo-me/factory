// fork(claude-agent): the chat transcript read from Factory's runtime-neutral session API.
/**
 * Same API as `useAgentControllerTranscript`, but the transcript comes from Factory's own event log
 * (`GET /web/factory/sessions/:id/transcript`, then `/events` from that `seq`) and is drawn through
 * `projectTranscript`, whatever runtime the session runs on. Optimistic local entries (the user's
 * own message before its echo, local notices, answered prompts) are overlaid on top.
 */
import { applyEvent, emptyTranscript } from '@factory/agent-runtime/browser';
import type { EventEnvelope, Transcript } from '@factory/agent-runtime/browser';
import type { AgentControllerEvent, MastraDBMessage } from '@mastra/client-js';
import type { MastraMessagePart } from '@mastra/core/agent-controller';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { useApiConfig } from '../../../../api/config';
import { projectTranscript } from '../services/factory-transcript-projection';
import { fetchFactoryTranscript, streamFactorySessionEvents } from '../services/factorySessionEvents';
import { createLocalMessageId } from '../services/transcript';
import type { MessageEntry, NoticeEntry, OutgoingFile, TimelineEntry, TranscriptState } from '../services/transcript';

interface LocalUser {
  entry: MessageEntry;
  text: string;
  /** How many user messages the transcript had when this was sent; its echo comes after them. */
  userMessagesBefore: number;
}

interface State {
  sessionId?: string;
  transcript: Transcript;
  ready: boolean;
  locals: LocalUser[];
  notices: NoticeEntry[];
  hidden: ReadonlySet<string>;
  pendingCleared: boolean;
}

type Action =
  | { type: 'reset'; sessionId?: string }
  | { type: 'snapshot'; sessionId: string; transcript: Transcript }
  | { type: 'envelope'; sessionId: string; envelope: EventEnvelope }
  | { type: 'localUser'; local: LocalUser }
  | { type: 'failLocalUser'; id: string }
  | { type: 'notice'; notice: NoticeEntry }
  | { type: 'hide'; id: string }
  | { type: 'clearPending' };

const initial = (sessionId?: string): State => ({
  sessionId,
  transcript: emptyTranscript(sessionId ?? ''),
  ready: false,
  locals: [],
  notices: [],
  hidden: new Set(),
  pendingCleared: false,
});

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return initial(action.sessionId);
    case 'snapshot':
      if (action.sessionId !== state.sessionId) return state;
      // A snapshot never moves the transcript backwards (a stream may already be ahead of it).
      return action.transcript.lastSeq >= state.transcript.lastSeq
        ? { ...state, transcript: action.transcript, ready: true }
        : { ...state, ready: true };
    case 'envelope':
      if (action.sessionId !== state.sessionId) return state;
      return { ...state, transcript: applyEvent(state.transcript, action.envelope) };
    case 'localUser':
      return { ...state, locals: [...state.locals, action.local], pendingCleared: false };
    case 'failLocalUser':
      return {
        ...state,
        locals: state.locals.flatMap(local => {
          if (local.entry.id !== action.id) return [local];
          // A steer stays visible as "Not sent"; a plain send that failed disappears.
          return local.entry.deliveryStatus === 'pending'
            ? [{ ...local, entry: { ...local.entry, deliveryStatus: 'failed' as const } }]
            : [];
        }),
      };
    case 'notice':
      return { ...state, notices: [...state.notices, action.notice] };
    case 'hide':
      return { ...state, hidden: new Set([...state.hidden, action.id]) };
    case 'clearPending':
      return { ...state, pendingCleared: true };
  }
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useFactorySessionTranscript({ sessionId }: { sessionId?: string; viewerId?: string } = {}) {
  const { baseUrl } = useApiConfig();
  const [state, dispatch] = useReducer(reducer, sessionId, initial);
  const lastSeq = useRef(0);
  lastSeq.current = state.transcript.lastSeq;

  useEffect(() => {
    dispatch({ type: 'reset', sessionId });
    lastSeq.current = 0;
    if (!sessionId) return;
    const controller = new AbortController();
    const { signal } = controller;

    void (async () => {
      let delay = RECONNECT_MIN_MS;
      let needSnapshot = true;
      while (!signal.aborted) {
        try {
          if (needSnapshot) {
            const transcript = await fetchFactoryTranscript(baseUrl, sessionId, signal);
            dispatch({ type: 'snapshot', sessionId, transcript });
            lastSeq.current = Math.max(lastSeq.current, transcript.lastSeq);
            needSnapshot = false;
          }
          const gap = new AbortController();
          await streamFactorySessionEvents(
            baseUrl,
            sessionId,
            lastSeq.current,
            {
              onConnected: () => {
                delay = RECONNECT_MIN_MS;
              },
              onEnvelope: envelope => {
                if (envelope.seq <= lastSeq.current) return;
                if (envelope.seq !== lastSeq.current + 1) {
                  // Missed events: start over from a fresh snapshot rather than draw a hole.
                  needSnapshot = true;
                  gap.abort();
                  return;
                }
                lastSeq.current = envelope.seq;
                dispatch({ type: 'envelope', sessionId, envelope });
              },
            },
            AbortSignal.any([signal, gap.signal]),
          );
        } catch {
          if (signal.aborted) return;
        }
        if (signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    })();
    return () => controller.abort();
  }, [baseUrl, sessionId]);

  const projected = useMemo(() => projectTranscript(state.transcript), [state.transcript]);

  const transcript: TranscriptState = useMemo(() => {
    const userTexts = projected.entries.flatMap(entry =>
      entry.kind === 'message' && entry.message.role === 'user' ? [textOf(entry.message)] : [],
    );
    // A local message disappears once its echo (same text, sent after it) is in the transcript.
    const claimed = new Set<number>();
    const unechoed = state.locals.filter(local => {
      for (let index = local.userMessagesBefore; index < userTexts.length; index++) {
        if (!claimed.has(index) && userTexts[index] === local.text.trim()) {
          claimed.add(index);
          return false;
        }
      }
      return true;
    });
    const entries: TimelineEntry[] = [
      ...projected.entries.filter(entry => !state.hidden.has(entry.id)),
      ...unechoed.map(local => local.entry),
      ...state.notices,
    ];
    const waitingOnSend = unechoed.some(local => local.entry.deliveryStatus !== 'failed');
    return {
      entries,
      pending: projected.running || (waitingOnSend && !state.pendingCleared),
      threadId: sessionId,
      tasks: projected.tasks,
    };
  }, [projected, state.locals, state.notices, state.hidden, state.pendingCleared, sessionId]);

  const userMessageCount = useRef(0);
  userMessageCount.current = projected.entries.filter(e => e.kind === 'message' && e.message.role === 'user').length;

  const localUser = useCallback((text: string, steer?: boolean, files?: OutgoingFile[]) => {
    const id = createLocalMessageId();
    const parts = [{ type: 'text', text }, ...(files ?? []).map(outgoingFilePart)] as MastraMessagePart[];
    const entry: MessageEntry = {
      kind: 'message',
      id,
      message: { id, role: 'user', createdAt: new Date(), content: { format: 2, parts } },
      ...(steer ? { steer: true, deliveryStatus: 'pending' as const } : {}),
    };
    dispatch({ type: 'localUser', local: { entry, text, userMessagesBefore: userMessageCount.current } });
    return id;
  }, []);

  const failLocalUser = useCallback((id: string) => dispatch({ type: 'failLocalUser', id }), []);
  const resolvePrompt = useCallback((id: string) => dispatch({ type: 'hide', id }), []);
  const clearPending = useCallback(() => dispatch({ type: 'clearPending' }), []);
  const pushNotice = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    dispatch({ type: 'notice', notice: { kind: 'notice', id: createLocalMessageId(), level, text } });
  }, []);
  // The Mastra transcript's inputs; Factory's log is the source here, so these are no-ops.
  const reset = useCallback((_threadId?: string) => {}, []);
  const onEvent = useCallback((_event: AgentControllerEvent) => {}, []);
  const mergeWindow = useCallback((_messages: MastraDBMessage[]) => {}, []);

  return {
    transcript,
    initialHistoryReady: state.ready || !sessionId,
    reset,
    onEvent,
    localUser,
    failLocalUser,
    resolvePrompt,
    clearPending,
    pushNotice,
    mergeWindow,
  };
}

function textOf(message: MastraDBMessage): string {
  return message.content.parts
    .flatMap(part => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim();
}

function outgoingFilePart(file: OutgoingFile): MastraMessagePart {
  return {
    type: 'file',
    data: file.data,
    mimeType: file.mediaType,
    ...(!file.mediaType.startsWith('image/') && file.filename ? { filename: file.filename } : {}),
  };
}
