import type { WorkItemBranchSource } from '../work-item-branch.js';

/** What a board filter reads of a card or of an issue not filed yet: where it came from and what that source says of it. */
export interface SourceFacts {
  source: WorkItemBranchSource;
  /** What the source says of the item: its labels and people. */
  metadata: Record<string, unknown>;
}

/** The source filters a board view picked. An empty set picks everything. */
export interface SourceFilters {
  source: ReadonlySet<string>;
}

/** Picks every card that has a pull request, whatever it was filed from. */
export const PULL_REQUEST_SOURCE_FILTER = 'pull-request';

/** The source a card is filtered under: its provider, whether it tracks an issue or a pull request. */
export function boardSource(source: WorkItemBranchSource): string {
  return source.split('-')[0] ?? source;
}

/** The sources a view keeps; empty keeps all. */
export function pickedBoardSources(filters: SourceFilters): ReadonlySet<string> {
  return filters.source;
}

/** Whether the view's source filter keeps the item. */
export function matchesSourceFilters(item: SourceFacts & { hasPullRequest: boolean }, filters: SourceFilters): boolean {
  const sources = pickedBoardSources(filters);
  if (
    sources.size > 0 &&
    !sources.has(boardSource(item.source)) &&
    !(sources.has(PULL_REQUEST_SOURCE_FILTER) && item.hasPullRequest)
  ) {
    return false;
  }
  return true;
}
