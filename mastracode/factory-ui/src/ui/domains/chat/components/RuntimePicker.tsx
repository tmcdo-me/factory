// fork(claude-agent): choose the agent runtime (draft) and Claude Agent's model.
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { ModelPicker as SharedModelPicker } from '@mastra/playground-ui/domains/llm';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { useSwitchSessionModelMutation } from '../../../../hooks/useSessionCommandMutations';
import { useChatSessionContext } from '../context/useChatSessionContext';
import {
  CLAUDE_AGENT_DEFAULT_MODEL,
  useDraftRuntime,
  useRuntimeCatalog,
  useSessionRuntimeQuery,
} from '../hooks/useSessionRuntime';
import { CLAUDE_AGENT_RUNTIME, MASTRA_CODE_RUNTIME, runtimeKeys, runtimeLabel } from '../services/factoryRuntimes';
import type { SessionRuntime } from '../services/factoryRuntimes';

/** The runtime the composer is on: the draft's choice, or the live session's. */
export function useChatRuntime(): SessionRuntime & { draft: boolean } {
  const { draftSessionId, sessionId } = useChatSessionContext();
  const { factoryId } = useParams<{ factoryId: string }>();
  const draft = useDraftRuntime(draftSessionId, factoryId);
  const live = useSessionRuntimeQuery(draftSessionId ? undefined : sessionId).data;
  if (draftSessionId) return { runtimeId: draft.runtimeId, modelId: draft.modelId, draft: true };
  return { runtimeId: live?.runtimeId ?? MASTRA_CODE_RUNTIME, modelId: live?.modelId, draft: false };
}

/** The display name of the runtime the composer is on, e.g. "Claude Agent". */
export function useChatRuntimeLabel(): string {
  const { runtimeId } = useChatRuntime();
  return runtimeLabel(useRuntimeCatalog().data, runtimeId);
}

/** Pick the runtime for a new session. Fixed once the session starts, so live sessions show nothing. */
export function RuntimePicker() {
  const { draftSessionId } = useChatSessionContext();
  const { factoryId } = useParams<{ factoryId: string }>();
  const catalog = useRuntimeCatalog().data;
  const draft = useDraftRuntime(draftSessionId, factoryId);
  if (!draftSessionId || !catalog || catalog.runtimes.length < 2) return null;
  return (
    <Select
      value={draft.runtimeId}
      onValueChange={runtimeId =>
        draft.setRuntime(
          runtimeId === CLAUDE_AGENT_RUNTIME ? { runtimeId, modelId: CLAUDE_AGENT_DEFAULT_MODEL } : { runtimeId },
        )
      }
    >
      <SelectTrigger size="sm" aria-label="Agent runtime">
        {runtimeLabel(catalog, draft.runtimeId)}
      </SelectTrigger>
      <SelectContent>
        {catalog.runtimes.map(runtime => (
          <SelectItem key={runtime.id} value={runtime.id}>
            {runtime.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Claude Agent's models. Claude Code signs in on its own, so there are no credentials to show. */
export function ClaudeModelPicker() {
  const { draftSessionId, sessionId, baseUrl } = useChatSessionContext();
  const { factoryId } = useParams<{ factoryId: string }>();
  const catalog = useRuntimeCatalog().data;
  const runtime = useChatRuntime();
  const draft = useDraftRuntime(draftSessionId, factoryId);
  const queryClient = useQueryClient();
  const switchModel = useSwitchSessionModelMutation({ sessionId, baseUrl });
  const models = catalog?.runtimes.find(r => r.id === CLAUDE_AGENT_RUNTIME)?.models ?? [];
  const modelId = runtime.modelId ?? CLAUDE_AGENT_DEFAULT_MODEL;

  const pick = (next: string) => {
    if (draftSessionId) {
      draft.setRuntime({ runtimeId: CLAUDE_AGENT_RUNTIME, modelId: next });
      return;
    }
    switchModel.mutate(
      { modelId: next },
      {
        onSuccess: () =>
          queryClient.setQueryData<SessionRuntime>(runtimeKeys.session(sessionId), {
            runtimeId: CLAUDE_AGENT_RUNTIME,
            modelId: next,
          }),
        onError: error => toast.error(error instanceof Error ? error.message : 'Could not switch the model'),
      },
    );
  };

  return (
    <SharedModelPicker
      providers={[
        { id: CLAUDE_AGENT_RUNTIME, name: 'Claude Agent', connected: true, models: models.map(m => ({ id: m.id })) },
      ]}
      value={{ provider: CLAUDE_AGENT_RUNTIME, model: modelId }}
      onValueChange={({ model }) => pick(model)}
    />
  );
}
