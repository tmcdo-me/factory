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

/** The badge for the card's pull request's CI, or none (green and not yet approved, or nothing known). */
export function pullRequestCiBadge(metadata: Record<string, unknown> | undefined): PullRequestCiBadge | undefined {
  const ci = metadata?.pullRequestCi as { status?: unknown; failing?: unknown } | null | undefined;
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
