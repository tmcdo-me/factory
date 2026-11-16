import type { AgentControllerSessionSettings } from '@mastra/client-js';
import {
  getAvailableThinkingLevelsForModel,
  parseThinkCommand,
  runThinkingLevel,
  THINK_COMMAND_DESCRIPTOR,
} from '@mastra/code-sdk/thinking';
import { useLocation, useNavigate, useParams } from 'react-router';

import { useAbortSessionMutation } from '../../../../hooks/useSessionCommandMutations';
import { useAgentControllerSettings } from '../../../../hooks/useAgentControllerSettings';
import { useModelReasoningOptions } from '../../../../hooks/useAvailableModels';
import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useUpdateAgentControllerSettingsMutation } from '../../../../hooks/useUpdateAgentControllerSettingsMutation';
import { sessionDefaultsAnchor, settingsSectionPath } from '../../settings/settingsSections';
import type { SlashCommand, SlashCommandOption } from '../services/commands';
import { findCommand, isSlashCommand, parseSlashCommand } from '../services/commands';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { DEFAULT_SOURCE_LABELS, THINKING_LEVEL_LABELS } from '../services/thinkingLevels';
import type { ThinkingDefault } from '../services/thinkingLevels';
import { useChatModels } from './useChatModels';
import { useChatModelScope } from './useChatModelScope';
import { useChatSessionContext } from './useChatSessionContext';
import { useChatThinking } from './useChatThinking';
import { useChatRuntime } from './useChatRuntime';
import { useChatTranscript } from './useChatTranscript';

function describeThinkingDefault({ level, origin }: ThinkingDefault): string {
  return `${level} (${DEFAULT_SOURCE_LABELS[origin]})`;
}

export function useChatCommandRegistry(prefillComposer: (draft: string) => void) {
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId, sessionEnabled, baseUrl, modelLockedReason } = useChatSessionContext();
  const { transcript, busy, pushNotice } = useChatTranscript();
  const { usage } = useChatRuntime();
  const { activeModelId, setModel } = useChatModels();
  const { catalogTarget, modelScope } = useChatModelScope();
  const activeModelReasoningOptions = useModelReasoningOptions(activeModelId, catalogTarget);
  const availableThinkingLevels = getAvailableThinkingLevelsForModel(activeModelId ?? '', activeModelReasoningOptions);

  const hookArgs = {
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  };
  const abortMutation = useAbortSessionMutation({ sessionId, baseUrl });
  const settingsQuery = useAgentControllerSettings(hookArgs);
  const updateSettingsMutation = useUpdateAgentControllerSettingsMutation(hookArgs);
  const { thinkingDefault } = useChatThinking();

  const openSessionDefaults = () => {
    if (factoryId)
      void navigate(settingsSectionPath(factoryId, 'models', sessionDefaultsAnchor(modelScope)), {
        state: { from: location },
      });
  };

  const currentThinkingLevel = settingsQuery.data?.thinkingLevel;
  const runningThinkingLevel =
    currentThinkingLevel && runThinkingLevel(activeModelId ?? '', currentThinkingLevel, activeModelReasoningOptions);
  const thinkingLevelOptions: SlashCommandOption[] = [
    {
      value: 'default',
      label: 'Default',
      ...(thinkingDefault ? { description: DEFAULT_SOURCE_LABELS[thinkingDefault.origin] } : {}),
      active: settingsQuery.data !== undefined && currentThinkingLevel === undefined,
    },
    ...availableThinkingLevels.map(level => ({
      value: level,
      label: THINKING_LEVEL_LABELS[level],
      active: runningThinkingLevel === level,
    })),
  ];

  const ensureSettings = async (): Promise<AgentControllerSessionSettings> => {
    if (settingsQuery.data) return settingsQuery.data;
    const result = await settingsQuery.refetch();
    if (!result.data) throw new Error('Session settings are unavailable');
    return result.data;
  };

  const commandsWithoutHelp: SlashCommand[] = [
    {
      name: 'model',
      args: '<id>',
      description: 'Switch model',
      requiresSession: true,
      execute: async rawArguments => {
        if (!rawArguments) return;
        if (modelLockedReason) return pushNotice(modelLockedReason);
        await setModel(rawArguments);
      },
    },
    {
      name: 'cost',
      description: 'Show token usage',
      requiresSession: false,
      execute: async () => {
        pushNotice(
          !usage?.totalTokens
            ? 'No token usage recorded yet.'
            : `Used ${usage.totalTokens} tokens (${usage.promptTokens ?? 0} prompt, ${usage.completionTokens ?? 0} completion).`,
        );
      },
    },
    {
      ...THINK_COMMAND_DESCRIPTOR,
      requiresSession: true,
      options: thinkingLevelOptions,
      execute: async (rawArguments, originalText) => {
        const action = parseThinkCommand(rawArguments, availableThinkingLevels);
        try {
          if (action.kind === 'invalid') {
            prefillComposer(originalText);
            pushNotice(
              `Unknown thinking level: ${action.value}. Use: ${action.levels.join(', ')}, default, status`,
              'error',
            );
            return;
          }
          const changesThinkingLevel = action.kind === 'set' || action.kind === 'clear';
          if (modelLockedReason && changesThinkingLevel) return pushNotice(modelLockedReason);
          if (action.kind === 'set') {
            await ensureSettings();
            await updateSettingsMutation.mutateAsync({ thinkingLevel: action.level });
            pushNotice(`Thinking level set to ${action.level}.`);
            return;
          }
          if (action.kind === 'clear') {
            await ensureSettings();
            await updateSettingsMutation.mutateAsync({ thinkingLevel: null });
            pushNotice(
              thinkingDefault
                ? `Thinking level set to default: ${describeThinkingDefault(thinkingDefault)}.`
                : 'Thinking level set to default. Current default is unavailable.',
            );
            return;
          }
          const settings = await ensureSettings();
          if (!thinkingDefault) throw new Error('The thinking default is unavailable');
          const defaultLevel = describeThinkingDefault(thinkingDefault);
          pushNotice(
            settings.thinkingLevel
              ? `Thinking level: ${settings.thinkingLevel} (session override). Default: ${defaultLevel}.`
              : `Thinking level: ${defaultLevel}.`,
          );
        } catch (error) {
          prefillComposer(originalText);
          throw error;
        }
      },
    },
    {
      name: 'settings',
      description: 'Show session state',
      requiresSession: false,
      execute: async () => {
        pushNotice(
          [
            `Factory: ${factoryQuery.data?.name ?? '(none)'}`,
            `Session: ${sessionId || '—'}`,
            `Model: ${activeModelId ?? '—'}`,
            `Thread: ${transcript.threadId ?? '—'}`,
            `Running: ${busy}`,
          ].join('\n'),
        );
      },
    },
    {
      name: 'connect',
      description: 'Connect a model provider',
      requiresSession: false,
      execute: async () => openSessionDefaults(),
    },
    {
      name: 'login',
      description: 'Sign in with a provider account',
      requiresSession: false,
      execute: async () => openSessionDefaults(),
    },
    {
      name: 'abort',
      description: 'Abort the current run',
      requiresSession: true,
      execute: async () => {
        await abortMutation.mutateAsync();
      },
    },
  ];

  const helpCommand: SlashCommand = {
    name: 'help',
    description: 'Show the command list',
    requiresSession: false,
    execute: async () => {
      const commands = [...commandsWithoutHelp, helpCommand];
      const lines = commands.map(command => {
        return `/${command.name}${command.args ? ` ${command.args}` : ''}: ${command.description}`;
      });
      pushNotice(['Available commands:', ...lines].join('\n'));
    },
  };

  const commands = [...commandsWithoutHelp, helpCommand];

  const runComposerCommand = async (text: string): Promise<boolean> => {
    if (!isSlashCommand(text)) return false;
    const command = findCommand(commands, text);
    const parsed = parseSlashCommand(text);
    if (!command) {
      prefillComposer(text);
      pushNotice(`Unknown command: /${parsed.name ?? ''}`, 'error');
      return true;
    }
    await command.execute(parsed.rawArguments, text);
    return true;
  };

  return { commands, runComposerCommand };
}
