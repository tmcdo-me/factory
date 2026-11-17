// fork(claude-agent): the chat UI's own names for the message and usage shapes it renders. The UI imports these
// instead of the controller's, so the seam-import lint can keep the controller out of this package.
// The message shapes are the stored DB message format (`@mastra/core/agent/message-list`), which the Factory
// transcript endpoint also serves; they are data, not part of the controller.
export type { MastraDBMessage, MastraMessagePart } from '@mastra/core/agent/message-list';

/** Token usage reported by a model step (structurally the same as the controller's). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
  raw?: unknown;
}
