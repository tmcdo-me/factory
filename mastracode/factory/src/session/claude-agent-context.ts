// fork(claude-agent): Factory's per-turn context (the card, its phase) for Claude Agent sessions.
import type { ClaudeTurnNotice } from '@factory/runtime-claude-agent';
import type { ComputeStateSignalArgs, ComputeStateSignalResult } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';

/** One piece of context as last told to a session, so the next turn tells only what changed. */
export interface ClaudeAgentContextBlock extends ClaudeTurnNotice {
  /** Which context this is (`factory-phase`); one block per id is current. */
  id: string;
  cacheKey: string;
  /** What the producer reads back next turn to tell a change from the last one. */
  metadata?: Record<string, unknown>;
}

/**
 * The context to tell a session with its next turn, given what it was last told (by id). Returns
 * only blocks that changed; an unchanged card adds nothing to the turn.
 */
export type ClaudeAgentContext = (
  requestContext: RequestContext,
  previous: ReadonlyMap<string, ClaudeAgentContextBlock>,
) => Promise<ClaudeAgentContextBlock[]>;

/** A Mastra Code state-signal processor, as Factory's `factory-phase` and `factory-work-item` are. */
export interface StateSignalSource {
  readonly stateId: string;
  computeStateSignal(args: ComputeStateSignalArgs): Promise<ComputeStateSignalResult>;
}

/**
 * Factory's state signals as Claude Agent context. Mastra Code shows a session these signals at
 * each step; a Claude Agent session gets the same text with each turn, whenever it changed since
 * the session was last told. The previous block stands in for the snapshot Mastra Code keeps in
 * the thread, so a phase change reads as an update and a card handed on says so.
 */
export function stateSignalContext(sources: readonly StateSignalSource[]): ClaudeAgentContext {
  return async (requestContext, previous) => {
    const blocks: ClaudeAgentContextBlock[] = [];
    for (const source of sources) {
      const last = previous.get(source.stateId);
      const snapshot = last
        ? { id: last.id, metadata: { ...last.metadata, state: { cacheKey: last.cacheKey } } }
        : undefined;
      let result: ComputeStateSignalResult;
      try {
        result = await source.computeStateSignal({
          requestContext,
          activeStateSignals: snapshot ? [snapshot] : [],
          contextWindow: { hasSnapshot: Boolean(snapshot) },
          ...(snapshot ? { lastSnapshot: snapshot, tracking: { currentCacheKey: last!.cacheKey } } : {}),
          deltasSinceSnapshot: [],
          stepNumber: 0,
          steps: [],
          state: {},
          messages: [],
        } as unknown as ComputeStateSignalArgs);
      } catch (error) {
        // Context is help, not a gate: a turn without it still runs.
        console.warn(`[factory] Claude Agent context '${source.stateId}' failed:`, error);
        continue;
      }
      if (!result || typeof result.contents !== 'string') continue;
      blocks.push({
        id: source.stateId,
        cacheKey: result.cacheKey ?? '',
        kind: 'state',
        tag: result.tagName ?? source.stateId,
        text: result.contents,
        ...(result.attributes ? { attributes: plainAttributes(result.attributes) } : {}),
        ...(result.metadata ? { metadata: result.metadata as Record<string, unknown> } : {}),
      });
    }
    return blocks;
  };
}

function plainAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
    ),
  );
}
