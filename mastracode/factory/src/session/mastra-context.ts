// fork(claude-agent): Mastra Code's side of Factory's context providers. Mastra Code keeps a session's
// context as state signals in its thread (a snapshot, then deltas); this maps one provider's block to
// the signal it stores and the signal Mastra keeps to what the provider is told it said last.
import type { ComputeStateSignalArgs, ComputeStateSignalResult } from '@mastra/core/processors';

import type { ContextBlock, ContextProvider, ContextRequest, PreviousContext } from './context-providers.js';

type Signal = { metadata?: Record<string, unknown> } | undefined;

const valueOf = (signal: Signal): Record<string, unknown> | undefined => {
  const value = signal?.metadata?.value;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
};

/** What Mastra Code's thread holds of this context, as the provider is told it. */
export function previousFromSignals(args: ComputeStateSignalArgs): PreviousContext | undefined {
  const hasBase = Boolean(args.lastSnapshot) && args.contextWindow.hasSnapshot;
  if (!hasBase) return undefined;
  let value: Record<string, unknown> | undefined;
  for (const signal of [...args.activeStateSignals].reverse()) {
    value = valueOf(signal);
    if (value) break;
  }
  value ??= valueOf(args.lastSnapshot);
  const cacheKey =
    args.tracking?.currentCacheKey ??
    (args.lastSnapshot?.metadata?.state as { cacheKey?: string } | undefined)?.cacheKey;
  return { ...(cacheKey !== undefined ? { cacheKey } : {}), ...(value ? { value } : {}) };
}

export function mastraStateSignal(block: ContextBlock): ComputeStateSignalResult {
  return {
    id: block.id,
    cacheKey: block.cacheKey,
    mode: block.mode,
    tagName: block.tag,
    contents: block.text,
    value: block.value,
    ...(block.delta !== undefined ? { delta: block.delta } : {}),
    ...(block.attributes ? { attributes: block.attributes } : {}),
    metadata: { value: block.value },
  } as ComputeStateSignalResult;
}

/** A Mastra Code processor's `computeStateSignal`, answered by a provider. */
export async function computeMastraStateSignal(
  provider: ContextProvider,
  args: ComputeStateSignalArgs,
): Promise<ComputeStateSignalResult> {
  const previous = previousFromSignals(args);
  const request: ContextRequest = {
    requestContext: args.requestContext,
    ...(previous ? { previous } : {}),
  };
  const block = await provider.provide(request);
  return block ? mastraStateSignal(block) : undefined;
}
