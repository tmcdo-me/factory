// fork(claude-agent): what a pull request's CI and reviews say, for its card (spec §6, 6g).

/** Where a card keeps what its pull request's CI and reviews say. */
export const PULL_REQUEST_CI_METADATA_KEY = 'pullRequestCi';

/** What the card shows. Merged and closed pull requests show as they always did (no CI status). */
export type PullRequestCiStatus = 'checks_running' | 'checks_failing' | 'changes_requested' | 'ready_to_merge' | 'checks_passed';

export interface PullRequestCiFailure {
  name: string;
  conclusion: string;
  url?: string;
  /** What the check said about itself (its title and summary): the CI's words, data only. */
  excerpt?: string;
}

/** The card's `pullRequestCi` metadata. */
export interface PullRequestCiMetadata {
  status: PullRequestCiStatus;
  pullRequestNumber: number;
  headSha: string;
  failing: Array<Omit<PullRequestCiFailure, 'excerpt'>>;
  updatedAt: string;
}

/** A check run or commit status as GitHub's REST API lists it, the fields read here. */
type Json = Record<string, unknown>;

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const STATUS_FAILED = new Set(['failure', 'error']);

/**
 * The pull request's status from its head's check runs and commit statuses and its reviews: a check
 * failing wins, then a reviewer's change request still standing, then checks still running, then an
 * approval with every check green (ready to merge), else green. `undefined` with nothing to say (no
 * checks, no reviews, or a closed pull request). Factory's own check runs (`ownApp`, its review
 * checks) aren't the repository's CI and don't count.
 */
export function pullRequestCiStatus(input: {
  open: boolean;
  checkRuns: readonly Json[];
  statuses: readonly Json[];
  /** Each reviewer's latest review state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`). */
  reviewStates: Readonly<Record<string, string>>;
  ownApp?: string;
}): { status: PullRequestCiStatus; failing: PullRequestCiFailure[] } | undefined {
  if (!input.open) return undefined;
  const runs = input.checkRuns.filter(run => {
    const slug = (run.app as Json | undefined)?.slug;
    return !input.ownApp || typeof slug !== 'string' || slug.toLowerCase() !== input.ownApp.toLowerCase();
  });
  // A commit status's context can be posted many times: the newest one counts.
  const latestStatuses = new Map<string, Json>();
  for (const status of input.statuses) {
    const context = String(status.context ?? '');
    if (!latestStatuses.has(context)) latestStatuses.set(context, status);
  }
  const failing: PullRequestCiFailure[] = [];
  let running = false;
  for (const run of runs) {
    if (run.status !== 'completed') {
      running = true;
      continue;
    }
    const conclusion = String(run.conclusion ?? '');
    if (!FAILED.has(conclusion)) continue;
    const output = (run.output ?? {}) as Json;
    const excerpt = [output.title, output.summary, output.text]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n')
      .slice(0, 1_500);
    failing.push({
      name: String(run.name ?? 'check'),
      conclusion,
      ...(typeof run.html_url === 'string' ? { url: run.html_url } : {}),
      ...(excerpt ? { excerpt } : {}),
    });
  }
  for (const status of latestStatuses.values()) {
    const state = String(status.state ?? '');
    if (state === 'pending') running = true;
    else if (STATUS_FAILED.has(state)) {
      failing.push({
        name: String(status.context ?? 'status'),
        conclusion: state,
        ...(typeof status.target_url === 'string' ? { url: status.target_url } : {}),
        ...(typeof status.description === 'string' && status.description ? { excerpt: status.description } : {}),
      });
    }
  }
  const states = Object.values(input.reviewStates);
  const changesRequested = states.includes('CHANGES_REQUESTED');
  const approved = states.includes('APPROVED');
  const hasChecks = runs.length > 0 || latestStatuses.size > 0;
  if (failing.length) return { status: 'checks_failing', failing };
  if (changesRequested) return { status: 'changes_requested', failing };
  if (running) return { status: 'checks_running', failing };
  if (approved) return { status: 'ready_to_merge', failing };
  return hasChecks ? { status: 'checks_passed', failing } : undefined;
}

/** A failure named the same way on every push that fails alike: the failing checks and how. */
export function failureSignature(failing: readonly PullRequestCiFailure[]): string {
  return failing
    .map(check => `${check.name}=${check.conclusion}`)
    .sort()
    .join(';');
}

/** Each reviewer's latest standing review, from the reviews listed oldest first. */
export function latestReviewStates(reviews: readonly Json[]): Record<string, string> {
  const states: Record<string, string> = {};
  for (const review of reviews) {
    const login = (review.user as Json | undefined)?.login;
    const state = String(review.state ?? '').toUpperCase();
    if (typeof login !== 'string' || state === 'PENDING') continue;
    // A comment doesn't take back an approval or a change request; a dismissal does.
    if (state === 'COMMENTED' && states[login]) continue;
    states[login] = state;
  }
  return states;
}
