import { createContext } from 'react';

export interface ChatThreadMessagesApi {
  threadId?: string;
  isPending: boolean;
  error: unknown;
  /** fork(claude-agent): ask again after `error`. */
  retry?: () => void;
}

export const ChatThreadMessagesContext = createContext<ChatThreadMessagesApi | null>(null);
