// fork(claude-agent): Factory's per-turn context (the card, its phase) for Claude Agent sessions.
import type { ClaudeTurnNotice } from '@factory/runtime-claude-agent';
import type { RequestContext } from '@mastra/core/request-context';

import type { ContextBlock, ContextProvider } from './context-providers.js';

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

/**
 * Factory's context providers as Claude Agent context. A Claude Agent session gets what Mastra Code
 * shows its sessions as state signals, with each turn, whenever it changed since the session was last
 * told. The previous block stands in for the snapshot Mastra Code keeps in the thread, so a phase
 * change reads as an update and a card handed on says so.
 */
export function providerContext(providers: readonly ContextProvider[]): ClaudeAgentContext {
  return async (requestContext, previous) => {
    const blocks: ClaudeAgentContextBlock[] = [];
    for (const provider of providers) {
      const last = previous.get(provider.id);
      let block: ContextBlock | undefined;
      try {
        block = await provider.provide({
          requestContext,
          ...(last
            ? {
                previous: {
                  cacheKey: last.cacheKey,
                  ...(isRecord(last.metadata?.value) ? { value: last.metadata.value } : {}),
                },
              }
            : {}),
        });
      } catch (error) {
        // Context is help, not a gate: a turn without it still runs.
        console.warn(`[factory] Claude Agent context '${provider.id}' failed:`, error);
        continue;
      }
      if (!block || typeof block.text !== 'string') continue;
      blocks.push({
        id: provider.id,
        cacheKey: block.cacheKey,
        kind: 'state',
        tag: block.tag,
        text: block.text,
        ...(block.attributes ? { attributes: plainAttributes(block.attributes) } : {}),
        // What the provider reads back next turn.
        metadata: { value: block.value },
      });
    }
    return blocks;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function plainAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
    ),
  );
}
