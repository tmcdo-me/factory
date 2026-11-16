// fork(claude-agent): whether a Claude Agent session's checkout holds content nobody vetted.
import { REVIEW_CONTEXT } from '../boards/define-board.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';

export type CheckoutPosture = 'trusted' | 'untrusted';

/**
 * A session's checkout posture, read from its run binding, as the start coordinator decides it for
 * Mastra Code: a review session, or any session on a pull-request card, works an attacker-writable
 * checkout. Fails closed: a lookup that throws, or a bound card that can't be read, is untrusted.
 * A session with no Factory row or no live binding works no card, so it is trusted.
 */
export function claudeAgentCheckoutPosture(deps: {
  sessions: {
    getBySessionId(sessionId: string): Promise<{ orgId: string; factoryProjectId?: string | null } | null>;
  };
  workItems: Pick<WorkItemsStorage, 'findActiveRunBindingForSession' | 'get'>;
}): (sessionId: string) => Promise<CheckoutPosture> {
  return async sessionId => {
    try {
      const row = await deps.sessions.getBySessionId(sessionId);
      if (!row?.factoryProjectId) return 'trusted';
      const binding = await deps.workItems.findActiveRunBindingForSession({
        orgId: row.orgId,
        factoryProjectId: row.factoryProjectId,
        sessionId,
      });
      if (!binding) return 'trusted';
      if (binding.role === REVIEW_CONTEXT) return 'untrusted';
      const item = await deps.workItems.get({ orgId: binding.orgId, id: binding.workItemId });
      return item && item.externalSource?.type !== 'pull-request' ? 'trusted' : 'untrusted';
    } catch (error) {
      console.warn(
        `[factory] Claude Agent session ${sessionId}: checkout posture unknown, treating it as untrusted`,
        error,
      );
      return 'untrusted';
    }
  };
}
