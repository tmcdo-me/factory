// fork(claude-agent): whether a Claude Agent session's checkout holds content nobody vetted.
import { REVIEW_CONTEXT } from '../boards/define-board.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';

export type CheckoutPosture = 'trusted' | 'untrusted';

/**
 * A session's checkout posture, read from every run binding it ever had, as the start coordinator
 * decides it for Mastra Code: a review session, or any session on a pull-request card, works an
 * attacker-writable checkout. Sticky: the checkout keeps a pull request's files after the review's
 * binding ends or is revoked, so a session that was ever untrusted stays untrusted. Fails closed: a
 * lookup that throws, a card that can't be read, or more than one live binding is untrusted. A
 * session with no Factory row or no binding ever worked no card, so it is trusted.
 */
export function claudeAgentCheckoutPosture(deps: {
  sessions: {
    getBySessionId(sessionId: string): Promise<{ orgId: string; factoryProjectId?: string | null } | null>;
  };
  workItems: Pick<WorkItemsStorage, 'listRunBindingsForSession' | 'get'>;
}): (sessionId: string) => Promise<CheckoutPosture> {
  return async sessionId => {
    try {
      const row = await deps.sessions.getBySessionId(sessionId);
      if (!row?.factoryProjectId) return 'trusted';
      const bindings = await deps.workItems.listRunBindingsForSession({
        orgId: row.orgId,
        factoryProjectId: row.factoryProjectId,
        sessionId,
      });
      if (bindings.length === 0) return 'trusted';
      if (bindings.filter(binding => binding.status === 'active').length > 1) return 'untrusted';
      if (bindings.some(binding => binding.role === REVIEW_CONTEXT)) return 'untrusted';
      for (const workItemId of new Set(bindings.map(binding => binding.workItemId))) {
        const item = await deps.workItems.get({ orgId: row.orgId, id: workItemId });
        if (!item || item.externalSource?.type === 'pull-request') return 'untrusted';
      }
      return 'trusted';
    } catch (error) {
      console.warn(
        `[factory] Claude Agent session ${sessionId}: checkout posture unknown, treating it as untrusted`,
        error,
      );
      return 'untrusted';
    }
  };
}
