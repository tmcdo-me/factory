import { Metadata } from '@mastra/playground-ui/components/Metadata';
import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { useDebouncedValue } from '@mastra/playground-ui/hooks/use-debounced-value';
import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';

import { useGithubReposQuery } from '../../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../../hooks/useGithubStatus';
import { PaletteRowsSkeleton } from '../../../../ui/PaletteRowsSkeleton';
import type { GithubRepo, GithubStatus, SourceControlRepository } from '../../services/github';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';
import { IconSettingsSliderHor } from '@mastra/playground-ui/icons/central/IconSettingsSliderHor';

export interface CreateFactoryRepositoryRowsProps {
  query: string;
  githubRedirecting: boolean;
  onConnect: () => void;
  onManageConnection: () => void;
  onSelectRepository: (repository: SourceControlRepository) => void;
}

function connectionMessage(status: GithubStatus | undefined): string {
  switch (status?.reason) {
    case 'missing_config':
      return 'GitHub is not configured for this deployment.';
    case 'organization_required':
      return 'Join an organization to connect GitHub repositories.';
    case 'auth_required':
      return 'Sign in again to connect GitHub.';
    default:
      return 'Install the GitHub App to grant access to repositories.';
  }
}

export function CreateFactoryRepositoryRows({
  query,
  githubRedirecting,
  onConnect,
  onManageConnection,
  onSelectRepository,
}: CreateFactoryRepositoryRowsProps) {
  const githubStatus = useGithubStatusQuery();
  const connected = githubStatus.data?.connected === true;
  if (githubStatus.isPending) {
    return <PaletteRowsSkeleton label="Loading repositories" rows={3} />;
  }

  const githubRows = !connected ? (
    (() => {
      const unavailable =
        githubStatus.data?.reason === 'organization_required' || githubStatus.data?.reason === 'missing_config';

      return (
        <CommandGroup heading="GitHub">
          <CommandPaletteItem
            icon={githubRedirecting ? <Spinner size="sm" aria-label="Connecting to GitHub" /> : <GithubIcon />}
            title={unavailable ? 'GitHub unavailable' : 'Connect GitHub'}
            subtitle={connectionMessage(githubStatus.data)}
            value="connect-github"
            disabled={unavailable || githubRedirecting}
            onSelect={onConnect}
          />
        </CommandGroup>
      );
    })()
  ) : (
    <>
      <GithubRepositoryResults query={query} onSelectRepository={onSelectRepository} />
      <CommandGroup heading="GitHub">
        <CommandPaletteItem
          icon={<IconSettingsSliderHor />}
          title="Manage GitHub connection"
          subtitle="Add installations or grant access to more repositories"
          value="manage-github"
          onSelect={onManageConnection}
        />
      </CommandGroup>
    </>
  );

  return githubRows;
}

function GithubRepositoryResults({
  query,
  onSelectRepository,
}: Pick<CreateFactoryRepositoryRowsProps, 'query' | 'onSelectRepository'>) {
  const debouncedQuery = useDebouncedValue(query, 750);
  const repos = useGithubReposQuery(debouncedQuery || undefined, true);

  if (repos.isPending) {
    return <PaletteRowsSkeleton label="Loading repositories" rows={3} />;
  }
  if (repos.isError) return <CreateFactoryPaletteAlert>{repos.error.message}</CreateFactoryPaletteAlert>;
  if (repos.data.length === 0) return <CreateFactoryPaletteMessage>No repositories found.</CreateFactoryPaletteMessage>;

  return (
    <CommandGroup heading="Repositories">
      {repos.data.map(repo => (
        <CommandPaletteItem
          key={repo.id}
          icon={<GithubIcon />}
          title={repo.fullName}
          subtitle={
            <Metadata singleLine>
              <Metadata.Item className="shrink-0">{repo.private ? 'Private' : 'Public'}</Metadata.Item>
              <Metadata.Item>{repo.defaultBranch}</Metadata.Item>
            </Metadata>
          }
          value={`repo-${repo.id}`}
          onSelect={() => onSelectRepository(repo)}
        />
      ))}
    </CommandGroup>
  );
}
