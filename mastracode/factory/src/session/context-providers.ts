// fork(claude-agent): Factory's per-turn context, independent of any runtime. A provider says what a
// session should be told (the card and its phase, the environment) given what it was last told; each
// runtime's adapter delivers it its own way: Mastra Code as state signals (`mastra-context.ts`),
// Claude Agent with the turn it changed for (`claude-agent-context.ts`).
import type { RequestContext } from '@mastra/core/request-context';

/** One piece of context to tell a session. */
export interface ContextBlock {
  /** Which context this is (`factory-phase`); one block per id is current. */
  id: string;
  /** Changes when the context does: an unchanged context is not told again. */
  cacheKey: string;
  /** A `delta` reads as an update to what the session was already told. */
  mode: 'snapshot' | 'delta';
  /** The tag the text is shown under. */
  tag: string;
  text: string;
  attributes?: Record<string, unknown>;
  /** What the provider reads back next turn (as `previous.value`) to tell a change from the last one. */
  value?: unknown;
  delta?: unknown;
}

/** What the session was last told by one provider, if it was. */
export interface PreviousContext {
  cacheKey?: string;
  value?: Record<string, unknown>;
}

export interface ContextRequest {
  /** The turn's request context: names the session (and its caller) the context is for. */
  requestContext: RequestContext | undefined;
  /** Present when the session already holds a block of this provider; absent on its first turn. */
  previous?: PreviousContext;
}

export interface ContextProvider {
  readonly id: string;
  /** The block to tell the session now, or nothing when there is none or it did not change. */
  provide(request: ContextRequest): Promise<ContextBlock | undefined>;
}

/** Whether `previous` already holds this block's cache key: nothing to tell. */
export function unchanged(previous: PreviousContext | undefined, cacheKey: string): boolean {
  return previous !== undefined && previous.cacheKey === cacheKey;
}
