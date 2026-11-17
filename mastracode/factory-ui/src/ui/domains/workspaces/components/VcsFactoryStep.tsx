import { Button } from '@mastra/playground-ui/components/Button';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { useDebouncedValue } from '@mastra/playground-ui/hooks/use-debounced-value';
import { cn } from '@mastra/playground-ui/utils/cn';
import { IconArrowRotateClockwise } from '@mastra/playground-ui/icons/central/IconArrowRotateClockwise';
import { useState } from 'react';

import { useGithubReposQuery, useRefreshGithubReposMutation } from '../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import type { SourceControlRepository } from '../services/github';
import { githubCallbackAwaitsAccess } from '../services/githubCallbackRecovery';
import { githubUnavailableReason } from '../services/sourceControlHosts';
import type { GitHubAppCallbackResult } from './GitHubAppCallbackHandler';
import { OnboardingGithubHostRow } from './onboarding/OnboardingGithubHostRow';
import { OnboardingGithubNotice } from './onboarding/OnboardingGithubNotice';
import { OnboardingInset } from './onboarding/OnboardingInset';
import { OnboardingRepositoryError } from './onboarding/OnboardingRepositoryError';
import { OnboardingRepositoryRows } from './onboarding/OnboardingRepositoryRows';
import { OnboardingSearchInset } from './onboarding/OnboardingSearchInset';
import { OnboardingStepCard } from './onboarding/OnboardingStepCard';

export interface VcsFactoryStepProps {
  initialRepository?: SourceControlRepository;
  githubRedirecting: boolean;
  githubCallback?: GitHubAppCallbackResult;
  onDismissGithubCallback: () => void;
  onConnect: () => void;
  onManageConnection: () => void;
  onSelectRepository: (repository: SourceControlRepository) => void;
  onPreviewRepository?: (repository: SourceControlRepository | undefined) => void;
}

export function VcsFactoryStep({
  initialRepository,
  githubRedirecting,
  githubCallback,
  onDismissGithubCallback,
  onConnect,
  onManageConnection,
  onSelectRepository,
  onPreviewRepository,
}: VcsFactoryStepProps) {
  const [chosenRepository, setChosenRepository] = useState(initialRepository);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 750);
  // Clearing the box shows the full list at once; only typing waits for the debounce.
  const search = query === '' ? '' : debouncedQuery;
  const githubStatus = useGithubStatusQuery();
  const connected = githubStatus.data?.connected === true;
  const repositoryForProvider = chosenRepository;
  const repositorySearch = search || undefined;
  const repos = useGithubReposQuery(repositorySearch, connected);
  const refreshRepos = useRefreshGithubReposMutation(repositorySearch);
  const repositoryQuery = repos;
  // A failed first load has no list; its empty-list text would wrongly blame repository access.
  const repositoriesFailed = repositoryQuery.isError && repositoryQuery.data === undefined;
  const refreshFailed = refreshRepos.isError;
  const statusPending = githubStatus.isPending;
  const chooseRepository = (repository: SourceControlRepository) => {
    setChosenRepository(repository);
    onPreviewRepository?.(repository);
  };
  const resetChoice = () => {
    setChosenRepository(undefined);
    onPreviewRepository?.(undefined);
    // A refresh failure was about the list it refreshed.
    refreshRepos.reset();
  };
  const showRepositories = !statusPending && connected;
  const showGithubRow = !statusPending && !connected;
  const refreshGithub = () => {
    // The repository refresh re-syncs status itself; refetching here too cancels and repeats it.
    if (connected) {
      const before = repos.data?.length ?? 0;
      refreshRepos.mutate(undefined, {
        // New repositories mean the access an approval or a Platform fix waited on has landed.
        onSuccess: next => {
          if (githubCallbackAwaitsAccess(githubCallback) && next.length > before) onDismissGithubCallback();
        },
      });
      return;
    }
    // A fix made elsewhere (an approval, Platform's Refresh accounts) shows up here; its notice is then moot.
    void githubStatus.refetch().then(result => {
      if (result.data?.connected) onDismissGithubCallback();
    });
  };

  return (
    <OnboardingStepCard
      section="vcs"
      notice={
        <OnboardingGithubNotice
          callback={githubCallback}
          statusReason={githubStatus.data?.reason}
          statusChecked={githubStatus.isFetchedAfterMount}
          redirecting={githubRedirecting}
          refreshing={githubStatus.isFetching || refreshRepos.isPending}
          onConnect={onConnect}
          onRefresh={refreshGithub}
          onDismiss={onDismissGithubCallback}
        />
      }
      actions={
        showRepositories && (
          <>
            <Button variant="ghost" size="sm" onClick={onManageConnection}>
              Manage access
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Refresh GitHub repositories"
              disabled={refreshRepos.isPending}
              onClick={refreshGithub}
            >
              <IconArrowRotateClockwise
                className={cn('size-3.5', refreshRepos.isPending && 'animate-spin')}
                aria-hidden="true"
              />
              Refresh
            </Button>
          </>
        )
      }
      primary={
        showRepositories && (
          <Button
            variant="primary"
            disabled={!repositoryForProvider}
            onClick={() => {
              if (repositoryForProvider) onSelectRepository(repositoryForProvider);
            }}
          >
            Continue
          </Button>
        )
      }
    >
      {statusPending && (
        <OnboardingInset>
          <SkeletonRows label="Loading source control status" rows={2} rowClassName="h-15 w-full" />
        </OnboardingInset>
      )}
      {showGithubRow && (
        <OnboardingInset>
          <OnboardingGithubHostRow
            redirecting={githubRedirecting}
            unavailableReason={githubUnavailableReason(githubStatus.data?.reason)}
            retrying={githubStatus.isFetching}
            onConnect={onConnect}
            onRetry={() => void githubStatus.refetch()}
          />
        </OnboardingInset>
      )}
      {showRepositories && (
        <OnboardingSearchInset
          search={
            <SearchInput
              label="Search repositories"
              placeholder="Find a repository"
              value={query}
              onValueChange={value => {
                setQuery(value);
                resetChoice();
              }}
            />
          }
        >
          {refreshFailed ? (
            <OnboardingRepositoryError
              message={refreshRepos.error.message}
              retrying={refreshRepos.isPending}
              onRetry={refreshGithub}
            />
          ) : (
            repositoryQuery.isError && (
              <OnboardingRepositoryError
                message={repositoryQuery.error.message}
                retrying={repositoryQuery.isFetching}
                onRetry={() => void repositoryQuery.refetch()}
              />
            )
          )}
          {!repositoriesFailed && (
            <div
              onMouseLeave={() => onPreviewRepository?.(repositoryForProvider)}
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) onPreviewRepository?.(repositoryForProvider);
              }}
            >
              <OnboardingRepositoryRows
                repositories={repos.data ?? []}
                search={search}
                pending={repositoryQuery.isPending}
                selectedRepositoryId={repositoryForProvider?.id}
                onSelectRepository={chooseRepository}
                onPreviewRepository={onPreviewRepository}
              />
            </div>
          )}
        </OnboardingSearchInset>
      )}
    </OnboardingStepCard>
  );
}
