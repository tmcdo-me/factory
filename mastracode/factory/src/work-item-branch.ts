import type { ExternalWorkItemSource } from './storage/domains/work-items/base.js';

/**
 * Where a card came from, in the vocabulary branch naming reads. Server rows
 * map their `externalSource` into this with {@link workItemBranchSource}; the
 * board's own `WorkItem['source']` is already this union.
 */
export type WorkItemBranchSource = 'github-issue' | 'github-pr' | 'detail-finding' | 'slack-thread' | 'manual';

export interface WorkItemBranchInput {
  id: string;
  source: WorkItemBranchSource;
  metadata?: Record<string, unknown> | null;
}

/** Map a stored item's provenance onto the source vocabulary branch naming reads. */
export function workItemBranchSource(externalSource: ExternalWorkItemSource | null | undefined): WorkItemBranchSource {
  if (!externalSource) return 'manual';
  if (externalSource.integrationId === 'detail') return 'detail-finding';
  // Only GitHub carries provider identities; anything else (a Slack thread, say)
  // is a plain work item rather than a mislabeled GitHub issue.
  if (externalSource.integrationId !== 'github') return 'manual';
  return externalSource.type === 'pull-request' ? 'github-pr' : 'github-issue';
}

function branchNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key] ?? metadata.number;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The provider number a GitHub card carries — the `#12` its runs and thread titles name it by. */
export function workItemNumber(item: Pick<WorkItemBranchInput, 'source' | 'metadata'>): number | undefined {
  const metadata = item.metadata ?? {};
  if (item.source === 'github-issue') return branchNumber(metadata, 'githubIssueNumber');
  if (item.source === 'github-pr') return branchNumber(metadata, 'githubPullRequestNumber');
  return undefined;
}

/** How a card names its thread: a GitHub card gets its number here. */
export function workItemThreadTitle(
  item: Pick<WorkItemBranchInput, 'source' | 'metadata'> & { title: string },
): string {
  const number = workItemNumber(item);
  if (number === undefined) return item.title;
  const kind = item.source === 'github-pr' ? 'PR' : 'Issue';
  return `${kind} #${number}: ${item.title}`;
}

/**
 * The last twelve alphanumerics of a work item id: the per-item suffix that keeps
 * provider numbers from colliding across the repositories of one factory. Issue
 * #13 exists in every repository, and a factory's sessions are unique per
 * user and branch across all of its repositories, so a branch named by the
 * number alone can only be held once per factory.
 */
function itemSuffix(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-12);
}

/**
 * The git branch an item's runs and sessions share, one grammar for both sides
 * of the wire: the dispatcher names autonomous run branches with it and the
 * board opens card sessions on it, so both converge on one checkout per item.
 * Provider numbers are only unique within a repository, so GitHub branches
 * carry the item suffix as well. Cards without a provider identity
 * (manual, Slack) and cards whose metadata lost their identifier fall back to
 * the id-derived branch.
 */
export function workItemBranch(item: WorkItemBranchInput): string {
  const providerNumber = workItemNumber(item);
  if (providerNumber !== undefined && (item.source === 'github-issue' || item.source === 'github-pr')) {
    const suffix = itemSuffix(item.id);
    const kind = item.source === 'github-issue' ? 'issue' : 'pr';
    return suffix ? `factory/${kind}-${providerNumber}-${suffix}` : `factory/${kind}-${providerNumber}`;
  }
  return `factory/item-${item.id}`;
}

/**
 * The branch a card's pull request is reviewed on. A PR's own card gets
 * the same name {@link workItemBranch} gives it; an issue card reviewing a PR
 * attached to it gets a branch apart from its builder's issue branch, so the
 * reviewer and the builder never share a checkout.
 */
export function pullRequestBranch(input: { id: string; number: number }): string {
  const suffix = itemSuffix(input.id);
  return suffix ? `factory/pr-${input.number}-${suffix}` : `factory/pr-${input.number}`;
}

/** The pre-suffix GitHub branch, for reusing sessions opened before card names were unique. */
export function legacyGithubWorkItemBranch(branch: string): string | undefined {
  const match = /^(factory\/(?:issue|pr)-[1-9]\d*)-[a-z0-9]{1,12}$/.exec(branch);
  return match?.[1];
}

/**
 * The pull request a `factory/pr-<number>-<item suffix>` branch was named after, the
 * inverse of {@link workItemBranch}. Branches from before the suffix (`factory/pr-<number>`)
 * still parse so existing checkouts can resolve their PR.
 */
export function pullRequestNumberFromBranch(branch: string): number | undefined {
  const match = /^factory\/pr-([1-9]\d*)(?:-[a-z0-9]{1,12})?$/.exec(branch);
  const number = match ? Number(match[1]) : undefined;
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

/** Whether a provider-reported branch name is safe to show an agent or pass to git. */
export function isSafeBranchName(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    !value.endsWith('.') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}
