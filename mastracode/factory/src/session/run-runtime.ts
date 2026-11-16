// fork(claude-agent): which agent runtime a board run's session uses.
import type { EventLog } from '@factory/agent-runtime';
import { MASTRA_CODE_RUNTIME_ID } from '@factory/runtime-mastra-code';

import type { FactoryStartRuntimes } from '../rules/start-coordinator.js';
import type { AgentSessionsStorage } from '../storage/domains/agent-sessions/base.js';

/**
 * Project defaults saved while auth is off (or by a personal account) are filed under `local`
 * (see `routes/agent-runtimes.ts`), so a project's own scope is read first, then that one.
 */
const UNSCOPED_ORG = 'local';

/**
 * A run's session keeps the runtime it has. One with no runtime record that has already run is a
 * Mastra Code session (every Mastra Code session is mirrored into the event log); one that never
 * ran takes its project's default, which is recorded so every later command routes to it.
 */
export function createRunRuntimes(options: {
  sessions: Pick<AgentSessionsStorage, 'get' | 'assign' | 'getProjectDefault'>;
  events: Pick<EventLog, 'list'>;
  /** Runtimes that hold their own conversation (everything but Mastra Code). */
  ownConversation: readonly string[];
}): FactoryStartRuntimes {
  const { sessions, events } = options;
  return {
    async sessionRuntime({ orgId, factoryProjectId, sessionId }) {
      const record = await sessions.get(sessionId);
      if (record) return record.runtimeId;
      if ((await events.list(sessionId, { limit: 1 })).length > 0) return MASTRA_CODE_RUNTIME_ID;
      const runtimeId =
        (await sessions.getProjectDefault({ orgId, projectId: factoryProjectId })) ??
        (orgId === UNSCOPED_ORG
          ? undefined
          : await sessions.getProjectDefault({ orgId: UNSCOPED_ORG, projectId: factoryProjectId })) ??
        MASTRA_CODE_RUNTIME_ID;
      if (runtimeId === MASTRA_CODE_RUNTIME_ID) return runtimeId;
      if (await sessions.assign(sessionId, runtimeId)) return runtimeId;
      // Another start chose first.
      return (await sessions.get(sessionId))?.runtimeId ?? MASTRA_CODE_RUNTIME_ID;
    },
    ownsConversation: runtimeId => options.ownConversation.includes(runtimeId),
  };
}
