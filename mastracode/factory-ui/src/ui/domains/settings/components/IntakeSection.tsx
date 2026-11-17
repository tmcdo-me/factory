import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { IconArrowRotateCounterClockwise } from '@mastra/playground-ui/icons/central/IconArrowRotateCounterClockwise';
import { Fragment } from 'react';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useIntakeBindingsQuery, useIntakeConfigQuery } from '../../../../hooks/useIntakeConfig';
import { GithubIntakeSection } from './GithubIntakeSection';
import { SettingsSubsection } from './SettingsSubsection';

type SourceListing = 'connected' | 'unavailable' | 'available';

function sourceListing(connected: boolean, unavailable: boolean): SourceListing {
  if (connected) return 'connected';
  if (unavailable) return 'unavailable';
  return 'available';
}

// Untitled: until every status loads, the sources can't be sorted into connected, unavailable or available.
function IntakeSkeleton() {
  return (
    <SettingsContainer>
      <SettingsSkeleton label="Loading intake sources" variant="item" rows={4} />
    </SettingsContainer>
  );
}

export function IntakeSection() {
  const configQuery = useIntakeConfigQuery();
  useIntakeBindingsQuery();
  const github = useGithubStatusQuery();

  if (configQuery.isPending) return <IntakeSkeleton />;
  if (!configQuery.data) {
    return (
      <SettingsContainer>
        <SettingsRow label="Intake configuration is unavailable" description="Your sources could not be loaded.">
          <Button
            size="sm"
            variant="ghost"
            icon={<IconArrowRotateCounterClockwise />}
            onClick={() => void configQuery.refetch()}
          >
            Retry
          </Button>
        </SettingsRow>
      </SettingsContainer>
    );
  }

  if (github.isPending) return <IntakeSkeleton />;

  const props = { config: configQuery.data };
  const githubListing = sourceListing(
    Boolean(github.data?.connected || github.data?.installations.length),
    github.isError || github.data?.reason === 'unavailable',
  );
  // Pass gated queries down: a new observer on an errored query refetches on mount and loops the gate.
  const sources = [
    {
      id: 'github',
      listing: githubListing,
      content: <GithubIntakeSection {...props} listed={githubListing !== 'available'} statusQuery={github} />,
    },
  ];
  const sourcesListed = (listing: SourceListing) => sources.filter(source => source.listing === listing);
  const connectedSources = sourcesListed('connected');
  const unavailableSources = sourcesListed('unavailable');
  const availableSources = sourcesListed('available');
  return (
    <>
      {connectedSources.length > 0 && (
        <SettingsSubsection
          scope="org"
          title="Connected sources"
          description="Choose which services bring work into your organization's boards."
        >
          {/* Each source is its own card: its summary row, then its sources and routing. */}
          <div className="flex flex-col gap-3">
            {connectedSources.map(source => (
              <Fragment key={source.id}>{source.content}</Fragment>
            ))}
          </div>
        </SettingsSubsection>
      )}
      {unavailableSources.length > 0 && (
        <SettingsSubsection title="Unavailable sources">
          <div className="flex flex-col gap-3">
            {unavailableSources.map(source => (
              <Fragment key={source.id}>{source.content}</Fragment>
            ))}
          </div>
        </SettingsSubsection>
      )}
      {availableSources.length > 0 && (
        <SettingsSubsection title="Add a source">
          <SettingsContainer>
            {availableSources.map(source => (
              <Fragment key={source.id}>{source.content}</Fragment>
            ))}
          </SettingsContainer>
        </SettingsSubsection>
      )}
    </>
  );
}
