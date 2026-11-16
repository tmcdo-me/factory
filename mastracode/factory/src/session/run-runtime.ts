// fork(claude-agent): which agent runtime a board run's session uses.
import type { EventLog } from '@factory/agent-runtime';
import { MASTRA_CODE_RUNTIME_ID } from '@factory/runtime-mastra-code';

import type { FactoryStartRuntimes } from '../rules/start-coordinator.js';
import type { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';

/** Where project defaults saved with auth off are filed (see `routes/agent-runtimes.ts`). */
const UNSCOPED_ORG = 'local';

/**
 * A run's session keeps the runtime it has. Only a session this start minted takes its project's
 * default, which is then recorded so every later command routes to it. A session with no runtime
 * record that already worked is a Mastra Code session: the card already holds it, or its thread has
 * messages (sessions from before the event mirror, or whose mirror writes failed, have no events), or
 * it has events. When any of that can't be read, the session stays on Mastra Code.
 */
export function createRunRuntimes(options: {
  sessions: Pick<AgentSessionsStorage, 'get' | 'assign' | 'getProjectDefault'>;
  events: Pick<EventLog, 'list'>;
  /** Whether the session's own thread (thread id = session id) has any message. */
  threadHasMessages(threadId: string): Promise<boolean>;
  /** Whether defaults filed under `local` apply: only with auth off, where every project is unscoped. */
  unscopedDefaults(): boolean;
  /** Runtimes that hold their own conversation (everything but Mastra Code). */
  ownConversation: readonly string[];
}): FactoryStartRuntimes {
  const { sessions, events } = options;
  return {
    async sessionRuntime({ orgId, factoryProjectId, sessionId, cardSession }) {
      try {
        const record = await sessions.get(sessionId);
        if (record) return record.runtimeId;
        if (cardSession) return MASTRA_CODE_RUNTIME_ID;
        const [ran, talked] = await Promise.all([
          events.list(sessionId, { limit: 1 }).then(list => list.length > 0),
          options.threadHasMessages(sessionId),
        ]);
        if (ran || talked) return MASTRA_CODE_RUNTIME_ID;
        const runtimeId =
          (await sessions.getProjectDefault({ orgId, projectId: factoryProjectId })) ??
          (orgId !== UNSCOPED_ORG && options.unscopedDefaults()
            ? await sessions.getProjectDefault({ orgId: UNSCOPED_ORG, projectId: factoryProjectId })
            : undefined) ??
          MASTRA_CODE_RUNTIME_ID;
        if (runtimeId === MASTRA_CODE_RUNTIME_ID) return runtimeId;
        if (await sessions.assign(sessionId, runtimeId)) return runtimeId;
        // Another start chose first.
        return (await sessions.get(sessionId))?.runtimeId ?? MASTRA_CODE_RUNTIME_ID;
      } catch (error) {
        console.warn(`[factory] Session ${sessionId}: choosing its runtime failed; it runs on Mastra Code`, error);
        return MASTRA_CODE_RUNTIME_ID;
      }
    },
    ownsConversation: runtimeId => options.ownConversation.includes(runtimeId),
  };
}
