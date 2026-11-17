import { pickedBoardSources, PULL_REQUEST_SOURCE_FILTER } from '@mastra/factory/work-items/card-source-filters';
import type { SourceFilters } from '@mastra/factory/work-items/card-source-filters';

export const BOARD_SOURCE_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'detail', label: 'Detail' },
  { value: 'manual', label: 'Manual' },
  // Not a provider: any card carrying a pull request, its own or attached to its issue.
  { value: PULL_REQUEST_SOURCE_FILTER, label: 'Pull requests' },
] as const;

/** Source filters determine which intake feeds to browse. */
export function hasBoardSourceFilters(filters: SourceFilters): boolean {
  return pickedBoardSources(filters).size > 0;
}
