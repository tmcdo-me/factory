// fork(claude-agent): how many Claude Agent turns this server runs at once (spec slice 13).
import { Input } from '@mastra/playground-ui/components/Input';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { SettingsRow } from '@mastra/playground-ui/new/settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useApiConfig } from '../../../../api/config';
import {
  fetchClaudeAgentConcurrency,
  runtimeKeys,
  setClaudeAgentConcurrency,
} from '../../chat/services/factoryRuntimes';
import type { ClaudeAgentConcurrency } from '../../chat/services/factoryRuntimes';

const MAX = 64;

/** The field's text for a stored value: empty follows the server's default. */
const shown = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

function rowDescription(state: ClaudeAgentConcurrency | undefined): string {
  const base =
    'How many Claude Agent sessions may run a turn at once, on this whole server. Over the limit, board runs and messages wait their turn; nothing is dropped. 0 is no limit.';
  if (!state) return base;
  const fallback =
    state.defaultMaxConcurrent === null
      ? 'no limit'
      : `${state.defaultMaxConcurrent} (FACTORY_CLAUDE_AGENT_MAX_CONCURRENT)`;
  const now = `${state.running} running${state.waiting ? `, ${state.waiting} waiting` : ''}.`;
  return `${base} Empty uses the server's default: ${fallback}. Now: ${now}`;
}

/** The Claude Agent concurrency limit, saved when the field is left or Enter is pressed. */
export function ClaudeAgentConcurrencyRow() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: runtimeKeys.claudeAgentConcurrency,
    queryFn: () => fetchClaudeAgentConcurrency(baseUrl),
    staleTime: 10_000,
  });
  const [draft, setDraft] = useState('');
  const stored = current.data?.maxConcurrent;
  useEffect(() => setDraft(shown(stored)), [stored]);
  const save = useMutation({
    mutationFn: (maxConcurrent: number | null) => setClaudeAgentConcurrency(baseUrl, maxConcurrent),
    onSuccess: state => queryClient.setQueryData(runtimeKeys.claudeAgentConcurrency, state),
    onError: error => {
      setDraft(shown(stored));
      toast.error(error instanceof Error ? error.message : 'Could not change the Claude Agent limit');
    },
  });

  const text = draft.trim();
  const invalid = text !== '' && !(/^\d+$/.test(text) && Number(text) <= MAX);
  const commit = () => {
    if (invalid || !current.data) return;
    const next = text === '' ? null : Number(text);
    if (next === current.data.maxConcurrent) return;
    save.mutate(next);
  };

  // Only an organization administrator may see or change the server's limit.
  if (current.error instanceof Error && /administrator/i.test(current.error.message)) return null;
  return (
    <SettingsRow
      label="Claude Agent runs at once"
      description={rowDescription(current.data)}
      errorMsg={
        current.error instanceof Error
          ? current.error.message
          : invalid
            ? `A whole number from 0 to ${MAX}, or empty.`
            : undefined
      }
    >
      <Input
        size="sm"
        inputMode="numeric"
        aria-label="Runs at once"
        placeholder={current.data?.defaultMaxConcurrent ? String(current.data.defaultMaxConcurrent) : 'No limit'}
        value={draft}
        disabled={!current.data || save.isPending}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') commit();
        }}
        className="w-24"
      />
    </SettingsRow>
  );
}
