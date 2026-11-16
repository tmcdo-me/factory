import type { SessionCommands } from '@factory/agent-runtime';

import type { ClaudeAgentSession } from './session';

/**
 * Session commands for Claude Agent sessions, addressed by Factory session id. `sessions` resolves
 * the live session (the host owns creating and resuming them).
 */
export function createClaudeAgentSessionCommands(sessions: {
  get(sessionId: string): Promise<ClaudeAgentSession | undefined> | ClaudeAgentSession | undefined;
}): SessionCommands {
  const live = async (sessionId: string) => {
    const session = await sessions.get(sessionId);
    return session && session.status() !== 'closed' ? session : undefined;
  };
  const notFound = { ok: false, reason: 'session_not_found' } as const;
  return {
    send: async (sessionId, input) => {
      const session = await live(sessionId);
      if (!session) return notFound;
      await session.send(input);
      return { ok: true };
    },
    abort: async sessionId => {
      const session = await live(sessionId);
      if (!session) return notFound;
      await session.abort();
      return { ok: true };
    },
    // Questions and plan approvals wait in the host's InteractionBroker; a host that has one (Factory)
    // answers through it. This plain helper has none.
    answer: async sessionId =>
      (await live(sessionId)) ? { ok: false, reason: 'not_pending', message: 'no_pending_interaction' } : notFound,
    setModel: async (sessionId, model) => {
      const session = await live(sessionId);
      if (!session) return notFound;
      await session.setModel(model.modelId);
      return { ok: true };
    },
  };
}
