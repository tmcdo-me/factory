import type { WorkItem } from '../../domains/factory/services/workItems';

const now = '2026-10-06T12:00:00.000Z';

function card(id: string, title: string, source: WorkItem['source'], stage: string): WorkItem {
  return {
    id,
    orgId: 'org-1',
    createdBy: 'user-1',
    githubProjectId: 'fp-1',
    board: 'work',
    source,
    sourceKey: `github-issue:${id}`,
    parentWorkItemId: null,
    title,
    url: null,
    stages: [stage],
    stageHistory: [{ stage, enteredAt: now, by: 'user-1' }],
    sessions: {},
    metadata: { labels: ['feature'] },
    triageType: null,
    acceptedAt: null,
    description: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export const sourceCards: WorkItem[] = [
  // GitHub issues reach the board as cards the server filed, never as live issues.
  card('101', 'Portal: add account switcher', 'github-issue', 'intake'),
  card('102', 'Portal: invite teammates', 'github-issue', 'intake'),
  card('103', 'Portal: workspace settings', 'github-issue', 'planning'),
  card('104', 'Portal: member permissions', 'github-issue', 'execute'),
  card('manual', 'Manual follow-up', 'manual', 'intake'),
  card('manual-2', 'Manual: write release notes', 'manual', 'planning'),
];

function wireSourceCard({ githubProjectId, source, sourceKey, url, ...item }: WorkItem) {
  const base = { ...item, factoryProjectId: githubProjectId };
  if (source === 'manual') return { ...base, externalSource: null };
  return { ...base, externalSource: { integrationId: 'github', type: 'issue', externalId: sourceKey, url } };
}

export const wireSourceCards = sourceCards.map(wireSourceCard);
