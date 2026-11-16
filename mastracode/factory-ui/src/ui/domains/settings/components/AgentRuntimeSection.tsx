// fork(claude-agent): the Factory's default agent runtime, for board runs and new sessions.
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { SettingsContainer, SettingsRow, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { useProjectRuntime, useRuntimeCatalog } from '../../chat/hooks/useSessionRuntime';
import { runtimeKeys, runtimeLabel, setProjectRuntime } from '../../chat/services/factoryRuntimes';
import { ClaudeAgentConcurrencyRow } from './ClaudeAgentConcurrencyRow';
import { SettingsSubsection } from './SettingsSubsection';

/**
 * Which agent runs this Factory's work: the runtime every board run starts on, and the one a new
 * session's composer picks first. A session keeps the runtime it started on.
 */
export function AgentRuntimeSection({ factoryId }: { factoryId: string }) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const catalog = useRuntimeCatalog();
  const current = useProjectRuntime(factoryId);
  const save = useMutation({
    mutationFn: (runtimeId: string) => setProjectRuntime(baseUrl, factoryId, runtimeId),
    onSuccess: (_result, runtimeId) => queryClient.setQueryData(runtimeKeys.project(factoryId), { runtimeId }),
    onError: error => toast.error(error instanceof Error ? error.message : 'Could not change the agent runtime'),
  });

  const title = 'Agent runtime';
  const description = 'The agent that board runs start on, and that new sessions use unless you pick another.';
  const error = catalog.error ?? current.error;
  if (error) {
    return (
      <SettingsSubsection scope="factory" title={title} description={description}>
        <Notice variant="destructive">
          {error instanceof Error ? error.message : 'Could not load agent runtimes'}
        </Notice>
      </SettingsSubsection>
    );
  }
  if (!catalog.data || !current.data) {
    return (
      <SettingsSubsection scope="factory" title={title} description={description}>
        <SettingsContainer>
          <SettingsSkeleton label="Loading the agent runtime" rows={1} />
        </SettingsContainer>
      </SettingsSubsection>
    );
  }

  const selected = save.isPending && save.variables ? save.variables : current.data.runtimeId;
  return (
    <SettingsSubsection scope="factory" title={title} description={description}>
      <SettingsContainer>
        <SettingsRow label="Default runtime" description="Sessions already started keep theirs.">
          <Select value={selected} onValueChange={runtimeId => save.mutate(runtimeId)} disabled={save.isPending}>
            <SelectTrigger size="sm" aria-label="Default agent runtime">
              {runtimeLabel(catalog.data, selected)}
            </SelectTrigger>
            <SelectContent>
              {catalog.data.runtimes.map(runtime => (
                <SelectItem key={runtime.id} value={runtime.id}>
                  {runtime.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <ClaudeAgentConcurrencyRow />
      </SettingsContainer>
    </SettingsSubsection>
  );
}
