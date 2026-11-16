import type { AgentControllerSessionState } from '@mastra/client-js';
import { createContext } from 'react';

import type { ConnectionStatus } from '../hooks/useAgentControllerConnection';

/**
 * What the chat reads of the session's live state. fork(claude-agent): Factory's session API fills
 * `running` (and the Mastra Code model) for sessions drawn from its event log; the Mastra
 * agent-controller connection fills all of it for sessions drawn from Mastra memory.
 */
export type ChatConnectionState = Partial<AgentControllerSessionState>;

export interface ChatConnectionApi {
  status: ConnectionStatus;
  state?: ChatConnectionState;
  threadId?: string;
  createdThreadId?: string;
}

export const ChatConnectionContext = createContext<ChatConnectionApi | null>(null);
