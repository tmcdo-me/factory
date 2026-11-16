// fork(claude-agent): mirror Mastra Code sessions into the runtime-neutral session event log.
import { SessionPublisher } from '@factory/agent-runtime';
import type { SessionEventHub } from '@factory/agent-runtime';
import { mirrorSessionEvents } from '@factory/runtime-mastra-code';
import type { MirrorableSession } from '@factory/runtime-mastra-code';

import { customModelContextWindow } from '../routes/custom-provider-source.js';

const mirrored = new WeakSet<object>();

/**
 * Shadow-write a Mastra Code session's events into Factory's event log (`@factory/agent-runtime`).
 * Read path only: nothing consumes the log yet, and failures are logged, never surfaced to the
 * session. Safe to call again for the same session object.
 */
export function observeSessionAgentEvents(
  session: MirrorableSession,
  hub: SessionEventHub,
  options: {
    /** The context window of the model the session runs now, when known (a custom provider's model). */
    contextWindow?: () => number | undefined;
  } = {},
): void {
  if (mirrored.has(session)) return;
  mirrored.add(session);
  const sessionId = session.identity.getId();
  let warned = false;
  const warnOnce = (what: string, error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[factory] agent event log: ${what} for session ${sessionId} failed (further failures for this session are not logged): ${error instanceof Error ? error.message : error}`,
    );
  };
  const publisher = new SessionPublisher(hub, sessionId, { onError: error => warnOnce('storing events', error) });
  mirrorSessionEvents(session, publisher.emit, {
    onError: error => warnOnce('mapping an event', error),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
  });
}

/**
 * The context window of the model a Mastra Code session runs now, when its organization's custom
 * provider sets one for it (Mastra's own catalog has none), read at each model step for the
 * composer's context meter.
 */
export function sessionModelContextWindow(session: {
  state: { get(): { factoryOrgId?: string } };
  model: { get(): string | undefined };
}): () => number | undefined {
  return () => customModelContextWindow(session.state.get().factoryOrgId, session.model.get());
}
