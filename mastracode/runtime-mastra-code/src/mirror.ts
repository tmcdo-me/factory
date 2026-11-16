import type { FactoryEvent } from '@factory/agent-runtime';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import { MastraCodeEventMapper } from './event-mapper';

/** The slice of a Mastra `Session` the mirror needs. */
export interface MirrorableSession {
  identity: { getId(): string };
  subscribe(listener: (event: AgentControllerEvent) => void | Promise<void>): () => void;
}

/**
 * Subscribe to a Mastra Code session and emit its events as `FactoryEvent`s. Mapping failures are
 * reported and skipped; they never reach the session. Returns the unsubscribe function.
 */
export function mirrorSessionEvents(
  session: MirrorableSession,
  emit: (event: FactoryEvent) => void,
  options: {
    onError?(error: unknown, event: AgentControllerEvent): void;
    /** The context window of the model the session runs now, when known (see `MastraCodeEventMapper`). */
    contextWindow?: () => number | undefined;
  } = {},
): () => void {
  const mapper = new MastraCodeEventMapper({
    sessionId: session.identity.getId(),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
  });
  return session.subscribe(event => {
    try {
      for (const mapped of mapper.map(event)) emit(mapped);
    } catch (error) {
      options.onError?.(error, event);
    }
  });
}
