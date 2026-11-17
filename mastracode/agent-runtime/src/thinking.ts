/**
 * Factory-owned thinking-level values, type and guard. Browser-safe (no Node imports). Factory, its storage and
 * its UI use these instead of Mastra Code's `@mastra/code-sdk/thinking`; a test in `@mastra/factory` pins the
 * values to the Mastra Code set so the two cannot drift apart silently.
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Same type under the name Factory's settings, storage and UI already use. */
export type ThinkingLevelSetting = ThinkingLevel;

export const THINKING_LEVEL_VALUES: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

export function isThinkingLevelSetting(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVEL_VALUES.some(level => level === value);
}
