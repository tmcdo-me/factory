/**
 * Browser-safe subset: the event and transcript types and the pure reducer, with no Node imports.
 * The Factory UI imports `@factory/agent-runtime/browser`.
 */
export type * from './events';
export type * from './interactions';
export type * from './transcript';
export type { Attachment, Author, TurnInput } from './runtime';
export type { ThinkingLevel, ThinkingLevelSetting } from './thinking';
export { THINKING_LEVEL_VALUES, isThinkingLevelSetting } from './thinking';

export { applyEvent, buildTranscript, emptyTranscript, finishedToolCalls } from './transcript';
