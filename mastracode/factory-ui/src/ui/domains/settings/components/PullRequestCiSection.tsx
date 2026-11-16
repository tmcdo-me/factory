// fork(claude-agent): how this Factory follows its pull requests' CI and reviews.
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { SettingsContainer, SettingsRow, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { fetchCiFollow, runtimeKeys, setCiFollow } from '../../chat/services/factoryRuntimes';
import type { CiFollowMode } from '../../chat/services/factoryRuntimes';
import { SettingsSubsection } from './SettingsSubsection';

const MODES: Record<CiFollowMode, string> = {
  off: 'Off',
  status: 'Show status',
  autofix: 'Show status and fix',
};

export function PullRequestCiSection({ factoryId }: { factoryId: string }) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: runtimeKeys.ciFollow(factoryId),
    queryFn: () => fetchCiFollow(baseUrl, factoryId),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (mode: CiFollowMode) => setCiFollow(baseUrl, factoryId, mode),
    onSuccess: state => queryClient.setQueryData(runtimeKeys.ciFollow(factoryId), state),
    onError: error =>
      toast.error(error instanceof Error ? error.message : 'Could not change how pull requests are followed'),
  });

  const title = 'Pull request checks';
  const description =
    "Cards show their pull request's checks and reviews. With fixing on, a failing check or a requested change sends the card back to its build with what failed, a few times at most, then waits for you. Factory never merges.";
  if (current.error) {
    return (
      <SettingsSubsection scope="factory" title={title} description={description}>
        <Notice variant="destructive">
          {current.error instanceof Error ? current.error.message : 'Could not load the setting'}
        </Notice>
      </SettingsSubsection>
    );
  }
  if (!current.data) {
    return (
      <SettingsSubsection scope="factory" title={title} description={description}>
        <SettingsContainer>
          <SettingsSkeleton label="Loading the pull request checks setting" rows={1} />
        </SettingsContainer>
      </SettingsSubsection>
    );
  }
  const selected = save.isPending && save.variables ? save.variables : current.data.mode;
  return (
    <SettingsSubsection scope="factory" title={title} description={description}>
      <SettingsContainer>
        <SettingsRow
          label="Follow checks"
          description={`Fixing tries ${current.data.maxAttempts} times per pull request, and stops early when a check fails the same way twice. Only feedback from people with write access counts, and never on someone else's pull request.${current.data.canChange === false ? ' Only an organization administrator can change this.' : ''}`}
        >
          <Select
            value={selected}
            onValueChange={mode => save.mutate(mode)}
            disabled={save.isPending || current.data.canChange === false}
          >
            <SelectTrigger size="sm" aria-label="Follow pull request checks">
              {MODES[selected]}
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MODES) as CiFollowMode[]).map(mode => (
                <SelectItem key={mode} value={mode}>
                  {MODES[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
