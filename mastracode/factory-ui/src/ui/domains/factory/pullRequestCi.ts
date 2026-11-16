// fork(claude-agent): what a card's pull request's CI and reviews say (`pullRequestCi` metadata).

export type PullRequestCiBadge = {
  label: string;
  tone: 'info' | 'destructive' | 'orange' | 'success';
  detail?: string;
};

const LABELS: Record<string, Omit<PullRequestCiBadge, 'detail'>> = {
  checks_running: { label: 'Checks running', tone: 'info' },
  checks_failing: { label: 'Checks failing', tone: 'destructive' },
  changes_requested: { label: 'Changes requested', tone: 'orange' },
  ready_to_merge: { label: 'Ready to merge', tone: 'success' },
};

/** The card's fields the badge reads: the pull request's record, its own (a PR card) or attached. */
interface CiCard {
  metadata?: Record<string, unknown>;
  workItem?: {
    metadata?: Record<string, unknown> | null;
    sources?: ReadonlyArray<{ sourceType?: string; metadata?: Record<string, unknown> | null }>;
  };
}

/** The `pullRequestCi` the poll keeps on the card's pull request record: the one the card has out first. */
function ciOf(card: CiCard): Record<string, unknown> | undefined {
  const own = card.workItem?.metadata?.pullRequestCi ?? card.metadata?.pullRequestCi;
  if (own && typeof own === 'object') return own as Record<string, unknown>;
  const out = card.metadata?.openPullRequestNumber;
  const records = (card.workItem?.sources ?? [])
    .filter(source => source.sourceType === 'pull-request')
    .map(source => source.metadata?.pullRequestCi)
    .filter((ci): ci is Record<string, unknown> => Boolean(ci) && typeof ci === 'object');
  return records.find(ci => ci.pullRequestNumber === out) ?? records.at(-1);
}

/** The badge for the card's pull request's CI, or none (green and not yet approved, or nothing known). */
export function pullRequestCiBadge(card: CiCard): PullRequestCiBadge | undefined {
  const ci = ciOf(card) as { status?: unknown; failing?: unknown } | undefined;
  const known = typeof ci?.status === 'string' ? LABELS[ci.status] : undefined;
  if (!known) return undefined;
  const failing = Array.isArray(ci?.failing)
    ? ci.failing.flatMap(check => {
        const name = (check as { name?: unknown }).name;
        return typeof name === 'string' ? [name] : [];
      })
    : [];
  return { ...known, ...(failing.length ? { detail: `Failing: ${failing.join(', ')}` } : {}) };
}
