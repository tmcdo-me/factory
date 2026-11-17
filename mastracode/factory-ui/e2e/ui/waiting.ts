// fork(claude-agent): fixtures for Factory's attention inbox, as the waiting page reads it.
import type { FactoryWaitingItem, FactoryWaitingPage } from '../../src/ui/domains/factory/services/waiting';

export const emptyAttention: FactoryWaitingPage & { kinds: Record<string, unknown> } = {
  items: [],
  kinds: {},
  hasMore: false,
};

/** A card's session waiting on a person, as `/web/factory/projects/:id/attention` lists it. */
export function waitingItem(
  overrides: Partial<FactoryWaitingItem> & Pick<FactoryWaitingItem, 'sessionId'>,
): FactoryWaitingItem {
  return {
    key: `fp-1:agent-waiting:${overrides.sessionId}:1`,
    kind: 'agent-waiting',
    threadId: overrides.sessionId,
    role: 'plan',
    toolName: 'ask_user',
    occurrence: 1,
    workItemId: 'item-1',
    title: 'Broken login',
    detail: 'Agent is waiting for an answer',
    occurredAt: '2026-11-16T12:00:00.000Z',
    read: false,
    archived: false,
    target: { kind: 'thread', sessionId: overrides.sessionId, threadId: overrides.sessionId },
    ...overrides,
  };
}
