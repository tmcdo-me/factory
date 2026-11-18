// fork(claude-agent): the Mastra Code thinking-level helpers Factory's UI uses, owned by the adapter package. A
// browser-safe subpath (no server imports) so the UI never imports `@mastra/code-sdk` itself (spec section 5).
// Re-exports only, no behaviour of its own.
export {
  getAvailableThinkingLevelsForModel,
  parseThinkCommand,
  runThinkingLevel,
  THINK_COMMAND_DESCRIPTOR,
} from '@mastra/code-sdk/thinking';
