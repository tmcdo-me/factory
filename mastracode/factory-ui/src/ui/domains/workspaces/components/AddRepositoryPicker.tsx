import { Metadata } from '@mastra/playground-ui/components/Metadata';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@mastra/playground-ui/components/Drawer';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useDebouncedValue } from '@mastra/playground-ui/hooks/use-debounced-value';
import { SettingsItem, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { IconArrowRotateClockwise } from '@mastra/playground-ui/icons/central/IconArrowRotateClockwise';
import { IconArrowRotateCounterClockwise } from '@mastra/playground-ui/icons/central/IconArrowRotateCounterClockwise';
import { IconCrossMedium } from '@mastra/playground-ui/icons/central/IconCrossMedium';
import { useRef, useState } from 'react';

import { useGithubReposQuery, useRefreshGithubReposMutation } from '../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { IntegrationItemIcon } from '../../settings/components/IntegrationItem';
import type { FactoryProject, GithubStatus, SourceControlRepository } from '../services/github';
import { IconPlusMedium } from '@mastra/playground-ui/icons/central/IconPlusMedium';

export function AddRepositoryPicker({
  factory,
  addingRepository,
  linkError,
  onAddRepository,
}: {
  factory: FactoryProject;
  addingRepository?: SourceControlRepository;
  linkError?: Error;
  onAddRepository: (repo: SourceControlRepository) => void;
}) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 750);
  const searchQuery = (query && debouncedQuery) || undefined;
  const searchInput = useRef<HTMLInputElement>(null);
  const githubStatus = useGithubStatusQuery();
  const githubConnected = githubStatus.data?.connected === true;
  const reposQuery = useGithubReposQuery(searchQuery, githubConnected);
  const refreshRepos = useRefreshGithubReposMutation(searchQuery);

  const linkedKeys = new Set(factory.repositories.map(repo => `${repo.provider ?? 'github'}:${repo.slug}`));
  const repositories: SourceControlRepository[] = reposQuery.data ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const available = repositories.filter(
    repo => !linkedKeys.has(`github:${repo.fullName}`) && repo.fullName.toLowerCase().includes(normalizedQuery),
  );
  const pending = githubStatus.isPending || (githubConnected && reposQuery.isPending);
  const error = githubStatus.error ?? reposQuery.error ?? refreshRepos.error ?? linkError;
  const githubUnavailable = githubStatus.data?.reason === 'unavailable';
  const statusUnavailable = githubUnavailable;
  const canSearch = githubConnected;
  const waitingForSearch =
    githubConnected && (query !== (searchQuery ?? '') || reposQuery.isPlaceholderData || reposQuery.isFetching);
  const loadingResults = pending || (available.length === 0 && waitingForSearch && !error && !statusUnavailable);

  return (
    <DrawerContent
      initialFocus={searchInput}
      showCloseButton={!addingRepository}
      aria-busy={Boolean(addingRepository) || undefined}
      className="overflow-hidden"
    >
      <DrawerHeader className="shrink-0">
        <DrawerTitle>Add repository</DrawerTitle>
        <div className="mt-3 flex items-center gap-2">
          <SearchInput
            label="Search repositories"
            placeholder="Search repositories"
            value={query}
            onValueChange={setQuery}
            ref={searchInput}
            disabled={Boolean(addingRepository)}
            className="min-w-0 flex-1"
          />
          {githubConnected && (
            <Button
              variant="ghost"
              size="icon-md"
              aria-label="Refresh GitHub repositories"
              disabled={refreshRepos.isPending}
              onClick={() => refreshRepos.mutate()}
            >
              <IconArrowRotateClockwise className={refreshRepos.isPending ? 'motion-safe:animate-spin' : undefined} />
            </Button>
          )}
        </div>
      </DrawerHeader>
      <DrawerBody className="min-h-0 overflow-x-hidden overflow-y-auto">
        {error && <Notice variant="destructive">{error.message}</Notice>}
        {githubUnavailable && (
          <StatusUnavailableNotice
            provider="GitHub"
            retrying={githubStatus.isFetching}
            onRetry={() => void githubStatus.refetch()}
          />
        )}
        {loadingResults ? (
          <SettingsSkeleton label="Loading available repositories" variant="item" rows={3} />
        ) : canSearch ? (
          <div className="divide-border flex flex-col divide-y *:py-3">
            {available.map(repo => (
              <SettingsItem
                key={`github:${repo.id}`}
                media={<IntegrationItemIcon provider="github" />}
                title={<span title={repo.fullName}>{repo.fullName}</span>}
                description={
                  <Metadata>
                    <Metadata.Item>{repo.private ? 'Private' : 'Public'}</Metadata.Item>
                    <Metadata.Item>Default branch: {repo.defaultBranch}</Metadata.Item>
                  </Metadata>
                }
              >
                <Button
                  size="sm"
                  icon={<IconPlusMedium />}
                  aria-label={`Add ${repo.fullName}`}
                  disabled={Boolean(addingRepository)}
                  onClick={() => onAddRepository(repo)}
                >
                  {addingRepository?.id === repo.id ? 'Adding…' : 'Add'}
                </Button>
              </SettingsItem>
            ))}
            {available.length === 0 && !error && !statusUnavailable && (
              <Txt as="p" variant="caption" tone="muted">
                {query
                  ? 'No repositories match your search.'
                  : 'No more repositories available. Check repository access with Manage under Source control.'}
              </Txt>
            )}
          </div>
        ) : !error && !statusUnavailable ? (
          <Txt as="p" variant="caption" tone="muted">
            {githubUnavailableMessage(githubStatus.data)}
          </Txt>
        ) : null}
      </DrawerBody>
      <DrawerFooter className="shrink-0">
        <DrawerClose
          disabled={Boolean(addingRepository)}
          render={
            <Button size="sm" icon={<IconCrossMedium />}>
              Cancel
            </Button>
          }
        />
      </DrawerFooter>
    </DrawerContent>
  );
}

function StatusUnavailableNotice({
  provider,
  retrying,
  onRetry,
}: {
  provider: 'GitHub';
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Notice
      variant="warning"
      action={
        <Button
          size="sm"
          variant="ghost"
          icon={<IconArrowRotateCounterClockwise />}
          disabled={retrying}
          onClick={onRetry}
        >
          Retry {provider}
        </Button>
      }
    >
      {provider} repositories could not be loaded.
    </Notice>
  );
}

function githubUnavailableMessage(status: GithubStatus | undefined): string {
  if (status?.authRequired || status?.reason === 'auth_required') return 'Sign in again to manage repository access.';
  if (status?.organizationRequired || status?.reason === 'organization_required')
    return 'Select an organization to connect repositories.';
  if (status?.reason === 'missing_config') {
    const missing = status.diagnostics?.missingGithubAppEnvVars ?? [];
    return missing.length > 0
      ? `GitHub is disabled on the server. Missing env vars: ${missing.join(', ')}.`
      : 'No source-control provider is configured on this server.';
  }
  return 'Connect GitHub to add repositories.';
}
