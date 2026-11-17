# Migration inventory

Non-test files coupled to Mastra Code's runtime (`@mastra/core/agent-controller`, `@mastra/code-sdk`,
or the agent-controller client). Generated 2026-11-15 from `9b9240047b`.
Tick a row when its file no longer imports these (or is deleted). Slice numbers refer to the spec §6.

## Server — `mastracode/factory/src`

| Done | File                                                   |  LOC | Slice | Note                                                                                                             |
| ---- | ------------------------------------------------------ | ---: | ----- | ---------------------------------------------------------------------------------------------------------------- |
| [ ]  | `auth.ts`                                              | 1022 | 7     |                                                                                                                  |
| [ ]  | `boards/define-board.ts`                               |  790 | 6     | dispatcher / boards / goals                                                                                      |
| [ ]  | `default-thinking-level.ts`                            |    3 | 7     |                                                                                                                  |
| [ ]  | `factory.ts`                                           | 2644 | 2→7   | composition root; shrinks every slice                                                                            |
| [ ]  | `integrations/base.ts`                                 |  322 | 7     |                                                                                                                  |
| [ ]  | `integrations/github/routes.ts`                        | 1771 | 7     |                                                                                                                  |
| [x]  | `integrations/github/session-subscriptions.ts`         |  375 | 7     |                                                                                                                  |
| [ ]  | `integrations/github/webhook.ts`                       |  649 | 7     |                                                                                                                  |
| [x]  | `integrations/gitlab/agent-tools.ts`                   |   56 | drop  | removed, not migrated (integration dropped)                                                                      |
| [x]  | `integrations/gitlab/session-subscriptions.ts`         |  254 | drop  | removed, not migrated (integration dropped)                                                                      |
| [x]  | `integrations/gitlab/webhook-dispatch.ts`              |  363 | drop  | removed, not migrated (integration dropped)                                                                      |
| [x]  | `integrations/incidentio/agent-tools.ts`               |  152 | drop  | removed, not migrated (integration dropped)                                                                      |
| [x]  | `integrations/jira/agent-tools.ts`                     |  127 | drop  | removed, not migrated (integration dropped)                                                                      |
| [x]  | `integrations/linear/agent-tools.ts`                   |  236 | drop  | removed, not migrated (integration dropped)                                                                      |
| [ ]  | `integrations/platform/github/event-worker.ts`         |  804 | drop  | Platform-hosted GitHub, kept when the other integrations were dropped; goes with the Mastra platform paths (§11) |
| [x]  | `integrations/platform/gitlab/event-worker.ts`         |  406 | drop  | removed, not migrated (integration dropped)                                                                      |
| [x]  | `integrations/platform/jira/agent-tools.ts`            |  120 | drop  | removed, not migrated (integration dropped)                                                                      |
| [ ]  | `integrations/slack/channel-session-link-processor.ts` |  121 | 7     |                                                                                                                  |
| [ ]  | `integrations/slack/run-error-card.ts`                 |   64 | 7     |                                                                                                                  |
| [x]  | `integrations/slack/share-file-tool.ts`                |  153 | 4     | tools → FactoryToolDef                                                                                           |
| [ ]  | `integrations/slack/slack.ts`                          | 1178 | 7     |                                                                                                                  |
| [ ]  | `integrations/subscription-session.ts`                 |  197 | 7     |                                                                                                                  |
| [ ]  | `routes/config.ts`                                     | 1800 | 7     |                                                                                                                  |
| [ ]  | `routes/contracts.ts`                                  | 1478 | 3     | session API                                                                                                      |
| [ ]  | `routes/custom-provider-source.ts`                     |  186 | 7     |                                                                                                                  |
| [ ]  | `routes/fs.ts`                                         | 1657 | 3     | session API                                                                                                      |
| [ ]  | `routes/oauth.ts`                                      |  515 | 12    | Claude OAuth removed (slice 12); still imports the code-sdk for the other providers' flows                       |
| [ ]  | `routes/provider-credentials.ts`                       |  182 | 7     |                                                                                                                  |
| [ ]  | `routes/skills.ts`                                     |  320 | 3     | session API                                                                                                      |
| [ ]  | `routes/source-control-sessions.ts`                    | 1057 | 3     | session API                                                                                                      |
| [ ]  | `routes/surface.ts`                                    | 1074 | 3     | session API                                                                                                      |
| [ ]  | `routes/tenant-credentials.ts`                         |  390 | 7     |                                                                                                                  |
| [ ]  | `routes/voice.ts`                                      |  281 | drop  | voice dropped                                                                                                    |
| [ ]  | `rules/binding-context.ts`                             |  210 | 6     | dispatcher / boards / goals                                                                                      |
| [ ]  | `rules/dispatcher.ts`                                  | 3008 | 6     | dispatcher / boards / goals                                                                                      |
| [ ]  | `rules/processor.ts`                                   |  834 | 6     | dispatcher / boards / goals                                                                                      |
| [ ]  | `rules/start-coordinator.ts`                           |  406 | 6     | dispatcher / boards / goals                                                                                      |
| [ ]  | `run-error.ts`                                         |  157 | 7     |                                                                                                                  |
| [ ]  | `sandbox/context-sandboxes.ts`                         |  151 | 7     |                                                                                                                  |
| [ ]  | `session/credential-policy.ts`                         |   99 | 7     |                                                                                                                  |
| [ ]  | `session/factory-session.ts`                           |  423 | 7     |                                                                                                                  |
| [ ]  | `session/filesystem-capture.ts`                        |  329 | 7     |                                                                                                                  |
| [ ]  | `session/first-exec-capture.ts`                        |  127 | 7     |                                                                                                                  |
| [ ]  | `session/first-message-capture.ts`                     |   50 | 7     |                                                                                                                  |
| [ ]  | `session/live-sessions.ts`                             |  154 | 7     |                                                                                                                  |
| [ ]  | `session/memory-settings-hydration.ts`                 |   46 | 7     |                                                                                                                  |
| [ ]  | `session/reply-credential-processor.ts`                |   51 | 7     |                                                                                                                  |
| [ ]  | `session/run-audit.ts`                                 |  302 | 7     |                                                                                                                  |
| [ ]  | `session/session-threads.ts`                           |  179 | 7     |                                                                                                                  |
| [x]  | `session/source-control-tools.ts`                      |  822 | 4     | tools → FactoryToolDef                                                                                           |
| [ ]  | `session/thinking-default.ts`                          |   60 | 7     |                                                                                                                  |
| [ ]  | `session/thread-session-stamp.ts`                      |   21 | 7     |                                                                                                                  |
| [ ]  | `session/thread-title-mirror.ts`                       |   75 | 7     |                                                                                                                  |
| [ ]  | `skills/service.ts`                                    |  120 | 6     | dispatcher / boards / goals                                                                                      |
| [ ]  | `storage/domains/audit/agent-audit.ts`                 |  122 | 7     |                                                                                                                  |
| [ ]  | `storage/domains/audit/domain.ts`                      |  381 | 7     |                                                                                                                  |
| [ ]  | `storage/domains/credentials/base.ts`                  |  430 | 7     |                                                                                                                  |
| [ ]  | `storage/domains/model-defaults/base.ts`               |  126 | 7     |                                                                                                                  |
| [ ]  | `storage/domains/projects/base.ts`                     |  592 | 7     |                                                                                                                  |
| [x]  | `tools/approval-tools.ts`                              |  220 | 5     | interactions: answers through the interaction broker (5c)                                                        |
| [x]  | `tools/deliver.ts`                                     |  204 | 5     | delivery through the target's runtime: Mastra Code's adapter, or Claude Agent's (5e)                             |
| [x]  | `tools/permissions.ts`                                 |   66 | 4     | tools → FactoryToolDef                                                                                           |
| [ ]  | `tools/run-watch.ts`                                   |  183 | 5     | interactions                                                                                                     |
| [x]  | `tools/scope.ts`                                       |  134 | 4     | tools → FactoryToolDef                                                                                           |
| [ ]  | `voice/transcription.ts`                               |  133 | drop  | voice dropped                                                                                                    |
| [ ]  | `workspace.ts`                                         | 1967 | 2→7   | composition root; shrinks every slice                                                                            |

## UI — `mastracode/factory-ui/src` (slice 3 unless noted)

| Done | File                                                                 |  LOC | Note                                          |
| ---- | -------------------------------------------------------------------- | ---: | --------------------------------------------- |
| [ ]  | `hooks/useActiveRunResources.ts`                                     |   49 |                                               |
| [x]  | `hooks/useAgentControllerGoalMutations.ts`                           |   40 | deleted (3d: goals UI dropped)                |
| [x]  | `hooks/useAgentControllerPermissionMutations.ts`                     |   70 | deleted (3d: permissions UI dropped)          |
| [x]  | `hooks/useAgentControllerPermissions.ts`                             |   31 | deleted (3d: permissions UI dropped)          |
| [x]  | `hooks/useAgentControllerRunMutations.ts`                            |  115 | deleted: `useSessionCommandMutations.ts` (3d) |
| [ ]  | `hooks/useAgentControllerSessionInit.ts`                             |   80 |                                               |
| [ ]  | `hooks/useAgentControllerSessionSync.ts`                             |   79 |                                               |
| [ ]  | `hooks/useAgentControllerSettings.ts`                                |   38 |                                               |
| [ ]  | `hooks/useAgentControllerStateMutations.ts`                          |   61 |                                               |
| [ ]  | `hooks/useAgentControllerThreadMessages.ts`                          |  141 |                                               |
| [x]  | `hooks/useAgentControllerThreadMutations.ts`                         |   54 | deleted (3d: multi-thread sessions dropped)   |
| [x]  | `hooks/useAgentControllerThreads.ts`                                 |   44 | deleted (3d: multi-thread sessions dropped)   |
| [x]  | `hooks/useRouteThreadSync.ts`                                        |  102 | deleted (3d: multi-thread sessions dropped)   |
| [ ]  | `hooks/useUpdateAgentControllerSettingsMutation.ts`                  |  106 |                                               |
| [ ]  | `ui/domains/chat/components/activity/activity-plan.ts`               |  208 |                                               |
| [ ]  | `ui/domains/chat/components/activity/HostedStretch.tsx`              |   69 |                                               |
| [ ]  | `ui/domains/chat/components/Composer.tsx`                            |  367 |                                               |
| [ ]  | `ui/domains/chat/components/MessageBubble.tsx`                       |  315 |                                               |
| [ ]  | `ui/domains/chat/components/SubmitPlanCard.tsx`                      |  165 |                                               |
| [ ]  | `ui/domains/chat/components/ToolFactory.tsx`                         |  159 |                                               |
| [ ]  | `ui/domains/chat/components/transcript-parts.ts`                     |  131 |                                               |
| [ ]  | `ui/domains/chat/components/Transcript.tsx`                          |  337 |                                               |
| [ ]  | `ui/domains/chat/components/TranscriptPromptCards.tsx`               |  203 |                                               |
| [ ]  | `ui/domains/chat/components/turn-gaps.ts`                            |   86 |                                               |
| [ ]  | `ui/domains/chat/context/ChatConnectionProvider.tsx`                 |   49 |                                               |
| [x]  | `ui/domains/chat/context/ChatPermissionsContext.ts`                  |   10 | deleted (3d: permissions UI dropped)          |
| [x]  | `ui/domains/chat/context/ChatPermissionsProvider.tsx`                |   54 | deleted (3d: permissions UI dropped)          |
| [ ]  | `ui/domains/chat/context/ChatTranscriptProvider.tsx`                 |  171 |                                               |
| [ ]  | `ui/domains/chat/context/useChatCommandRegistry.ts`                  |  323 |                                               |
| [ ]  | `ui/domains/chat/hooks/useAgentControllerConnection.ts`              |  208 |                                               |
| [ ]  | `ui/domains/chat/hooks/useAgentControllerEvents.ts`                  |  151 |                                               |
| [ ]  | `ui/domains/chat/hooks/useAgentControllerTranscript.ts`              |   80 |                                               |
| [ ]  | `ui/domains/chat/hooks/useCreateUserSessionFromDraft.ts`             |   90 |                                               |
| [ ]  | `ui/domains/chat/hooks/usePendingPlanFeedback.ts`                    |   65 |                                               |
| [ ]  | `ui/domains/chat/services/agentControllerClient.ts`                  |  126 |                                               |
| [ ]  | `ui/domains/chat/services/message-author.ts`                         |   81 |                                               |
| [x]  | `ui/domains/chat/services/om.ts`                                     |   35 | deleted (3d: OM UI dropped)                   |
| [ ]  | `ui/domains/chat/services/run-activity.ts`                           |   92 |                                               |
| [ ]  | `ui/domains/chat/services/runtime.ts`                                |  217 |                                               |
| [ ]  | `ui/domains/chat/services/transcript.ts`                             | 1428 |                                               |
| [ ]  | `ui/domains/settings/components/SettingsPanel.parts.tsx`             |  166 |                                               |
| [ ]  | `ui/domains/settings/components/SettingsPanel.tsx`                   |   91 |                                               |
| [ ]  | `ui/domains/workspace-viewer/useRefreshWorkspaceFilesOnToolCalls.ts` |   70 |                                               |
