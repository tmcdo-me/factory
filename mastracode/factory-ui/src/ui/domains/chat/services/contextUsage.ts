// fork(claude-agent): how full the model's context is, for the composer's context meter.
import type { Transcript } from '@factory/agent-runtime/browser';
import type { TokenUsage } from './message-types';

/**
 * Tokens in the main agent's context: the whole prompt of its latest model call, a snapshot rather
 * than a running total. `window` is the model's context window, absent when nothing reports one
 * (Mastra Code's catalog doesn't know windows; Claude Agent reports one per turn).
 */
export interface ContextUsage {
  tokens: number;
  window?: number;
}

/** From Factory's event log, whatever runtime wrote it. Older usage events carry no context. */
export function contextFromFactoryUsage(usage: Transcript['usage']): ContextUsage | undefined {
  if (usage?.contextTokens === undefined) return undefined;
  return { tokens: usage.contextTokens, ...(usage.contextWindow ? { window: usage.contextWindow } : {}) };
}

/**
 * From a Mastra Code `usage_update`, which reports one model step: its prompt is what the model had
 * in context (the same number the runtime-mastra-code mirror logs). Never the session's
 * `tokenUsage`, which sums every step.
 */
export function contextFromStepUsage(usage: TokenUsage): ContextUsage {
  return { tokens: usage.promptTokens };
}
