// fork(claude-agent): spec section 5. Factory and its UI reach agents through `@factory/agent-runtime`; they
// do not import Mastra Code's agent controller or SDK. Slice 7 shrinks these lists to empty: each file listed
// still imports one of them. Remove a file from its list in the change that removes its import (the rule then
// guards it); a new file may not be added. Test files are exempt (the adapter's tests move with it).
import { defineConfig } from 'oxlint';

export const restrictedMastraCodeImports = {
  patterns: [
    {
      group: ['@mastra/code-sdk', '@mastra/code-sdk/*', '@mastra/core/agent-controller'],
      message:
        'Use @factory/agent-runtime (spec section 5); Mastra Code internals live in @factory/runtime-mastra-code.',
    },
  ],
};

/** Files under `mastracode/factory` that still import Mastra Code's controller or SDK. */
export const factoryAllowList: string[] = [
  'src/auth.ts',
  'src/boards/define-board.ts',
  'src/default-thinking-level.ts',
  'src/factory.ts',
  'src/integrations/base.ts',
  'src/integrations/github/routes.ts',
  'src/integrations/mastra-code-subscription-sessions.ts',
  'src/integrations/slack/slack.ts',
  'src/routes/config.ts',
  'src/routes/contracts.ts',
  'src/routes/custom-provider-source.ts',
  'src/routes/fs.ts',
  'src/routes/oauth.ts',
  'src/routes/provider-credentials.ts',
  'src/routes/skills.ts',
  'src/routes/source-control-sessions.ts',
  'src/routes/surface.ts',
  'src/routes/tenant-credentials.ts',
  'src/routes/voice.ts',
  'src/rules/binding-context.ts',
  'src/rules/dispatcher.ts',
  'src/rules/mastra-code-sessions.ts',
  'src/rules/processor.ts',
  'src/rules/start-coordinator.ts',
  'src/rules/watch-run.ts',
  'src/run-error.ts',
  'src/sandbox/context-sandboxes.ts',
  'src/session/claude-agent-workspace.ts',
  'src/session/controller-event-hub.ts',
  'src/session/credential-policy.ts',
  'src/session/factory-session.ts',
  'src/session/filesystem-capture.ts',
  'src/session/first-message-capture.ts',
  'src/session/live-sessions.ts',
  'src/session/memory-settings-hydration.ts',
  'src/session/reply-credential-processor.ts',
  'src/session/session-threads.ts',
  'src/session/thinking-default.ts',
  'src/session/thread-session-stamp.ts',
  'src/session/thread-title-mirror.ts',
  'src/skills/service.ts',
  'src/storage/domains/credentials/base.ts',
  'src/storage/domains/model-defaults/base.ts',
  'src/storage/domains/projects/base.ts',
  'src/voice/transcription.ts',
  'src/workspace.ts',
];

/** Files under `mastracode/factory-ui` that still import Mastra Code's SDK or controller types. */
export const factoryUiAllowList: string[] = [
  'src/api/types.ts',
  'src/hooks/use-default-model.ts',
  'src/hooks/use-thinking.ts',
  'src/hooks/useSessionModelCatalog.ts',
  'src/ui/domains/chat/components/StatusLine/useSessionThinking.ts',
  'src/ui/domains/chat/components/turn-gaps.ts',
  'src/ui/domains/chat/context/ChatThinkingContext.ts',
  'src/ui/domains/chat/context/ChatThinkingProvider.tsx',
  'src/ui/domains/chat/context/ChatTranscriptProvider.tsx',
  'src/ui/domains/chat/context/useChatCommandRegistry.ts',
  'src/ui/domains/chat/hooks/useCreateUserSessionFromDraft.ts',
  'src/ui/domains/chat/hooks/useEffectiveThinkingLevel.ts',
  'src/ui/domains/chat/hooks/useFactorySessionTranscript.ts',
  'src/ui/domains/chat/hooks/useHandoffPrompt.ts',
  'src/ui/domains/chat/services/contextUsage.ts',
  'src/ui/domains/chat/services/factory-transcript-projection.ts',
  'src/ui/domains/chat/services/handoffFiles.ts',
  'src/ui/domains/chat/services/message-author.ts',
  'src/ui/domains/chat/services/run-activity.ts',
  'src/ui/domains/chat/services/runtime.ts',
  'src/ui/domains/chat/services/thinkingLevels.ts',
  'src/ui/domains/chat/services/transcript.ts',
  'src/ui/domains/settings/components/models/defaults/FactoryThinkingControl.tsx',
  'src/ui/domains/settings/components/models/defaults/PersonalDefaultModelPicker.tsx',
  'src/ui/domains/settings/components/models/defaults/PersonalThinkingControl.tsx',
  'src/ui/domains/workspaces/services/github.ts',
];

/** The overrides that enforce the ban outside `allowList`. */
export function seamImportOverrides(allowList: string[]): ReturnType<typeof defineConfig>['overrides'] {
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      rules: { 'no-restricted-imports': ['error', restrictedMastraCodeImports] },
    },
    { files: allowList, rules: { 'no-restricted-imports': 'off' } },
    { files: ['**/*.test.*', '**/__tests__/**'], rules: { 'no-restricted-imports': 'off' } },
  ];
}
