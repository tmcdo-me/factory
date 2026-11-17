import { SkeletonText } from '@mastra/playground-ui/components/Skeleton';

import { useGitHubIssueDetail, useGitHubPullRequestDetail } from '../../../../hooks/useFactoryData';
import { githubNumberForItem } from '../boardItems';
import type { WorkItem } from '../services/workItems';
import { DescriptionMarkdown } from './DescriptionMarkdown';
import { Txt } from '@mastra/playground-ui/components/Txt';

/** The card's source and metadata — a work item or an unfiled candidate. */
type SourceItem = Pick<WorkItem, 'source' | 'sourceKey' | 'workItem' | 'metadata'>;

function descriptionSource(item: SourceItem): 'issue' | 'pull' | undefined {
  if (githubNumberForItem(item) === undefined) return undefined;
  if (item.source === 'github-issue') return 'issue';
  if (item.source === 'github-pr') return 'pull';
  return undefined;
}

/** The body behind the card; undefined for sources with none to fetch (manual, Slack). */
export function useSourceDescription(
  item: SourceItem,
  projectRepositoryId: string | undefined,
  _factoryProjectId: string | undefined,
) {
  const number = githubNumberForItem(item);
  const source = descriptionSource(item);
  const issue = useGitHubIssueDetail(
    source === 'issue' ? projectRepositoryId : undefined,
    source === 'issue' ? number : undefined,
  );
  const pull = useGitHubPullRequestDetail(
    source === 'pull' ? projectRepositoryId : undefined,
    source === 'pull' ? number : undefined,
  );
  return source === undefined ? undefined : { issue, pull }[source];
}

export function SourceDescriptionLoading() {
  return (
    <div role="status" aria-label="Loading description">
      <div aria-hidden>
        <SkeletonText line="text-caption" className="w-full motion-reduce:before:animate-none" />
        <SkeletonText line="text-caption" className="w-4/5 motion-reduce:before:animate-none" />
        <SkeletonText line="text-caption" className="w-2/3 motion-reduce:before:animate-none" />
      </div>
    </div>
  );
}

export function CardSourceDescription({
  item,
  projectRepositoryId,
  factoryProjectId,
}: {
  item: SourceItem;
  projectRepositoryId: string | undefined;
  factoryProjectId: string | undefined;
}) {
  const query = useSourceDescription(item, projectRepositoryId, factoryProjectId);
  if (query === undefined) return null;

  if (query.isLoading) return <SourceDescriptionLoading />;
  if (query.isError) {
    return (
      <Txt variant="meta" tone="muted" className="m-0">
        The description could not be loaded.
      </Txt>
    );
  }
  const description = query.data?.description ?? null;
  if (description === null || description.trim() === '') return null;
  return <DescriptionMarkdown titleLevel="h3">{description}</DescriptionMarkdown>;
}
