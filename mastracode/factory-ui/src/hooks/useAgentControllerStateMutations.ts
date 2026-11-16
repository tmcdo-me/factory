import type { AgentControllerThinkingLevel } from '@mastra/client-js';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import type { AgentControllerMutationArgs } from './agentControllerMutationArgs';
import {
  createAgentControllerClient,
  requireAgentControllerSession,
} from '../ui/domains/chat/services/agentControllerClient';
// fork(claude-agent): with the Factory transcript source, the model switch goes to Factory's session API.
import { switchFactorySessionModel } from '../ui/domains/chat/services/factorySessionCommands';
import { resolveSessionRuntime, usesFactorySessionApi } from '../ui/domains/chat/hooks/useSessionRuntime';

export function useSetAgentControllerStateMutation({
  agentControllerId,
  sessionId,
  baseUrl = '',
  enabled = true,
}: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient({ agentControllerId, sessionId, baseUrl, enabled });

  return useMutation({
    mutationFn: (updates: Record<string, unknown>) => requireAgentControllerSession(session).setState(updates),
    onSuccess: async (_data, updates) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(agentControllerId, sessionId),
        }),
        'settings' in updates
          ? queryClient.invalidateQueries({
              queryKey: queryKeys.agentControllerSettings(agentControllerId, sessionId),
              exact: true,
            })
          : Promise.resolve(),
      ]);
    },
  });
}

interface ModelSwitch {
  modelId: string;
  thinkingLevel?: AgentControllerThinkingLevel;
}

export function useSwitchAgentControllerModelMutation(args: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient(args);

  return useMutation({
    mutationFn: async ({ modelId, thinkingLevel }: ModelSwitch) =>
      usesFactorySessionApi(
        await resolveSessionRuntime(queryClient, args.baseUrl ?? '', args.sessionId).catch(() => undefined),
      )
        ? switchFactorySessionModel(args.baseUrl ?? '', args.sessionId, modelId, thinkingLevel)
        : requireAgentControllerSession(session).switchModel(modelId, { thinkingLevel }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(args.agentControllerId, args.sessionId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerSettings(args.agentControllerId, args.sessionId),
          exact: true,
        }),
      ]),
  });
}
