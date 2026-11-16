// fork(claude-agent): mirror Mastra Code sessions into the runtime-neutral session event log.
import { SessionPublisher } from '@factory/agent-runtime';
import type { SessionEventHub } from '@factory/agent-runtime';
import { mirrorSessionEvents } from '@factory/runtime-mastra-code';
import type { MirrorableSession } from '@factory/runtime-mastra-code';

const mirrored = new WeakSet<object>();

/**
 * Shadow-write a Mastra Code session's events into Factory's event log (`@factory/agent-runtime`).
 * Read path only: nothing consumes the log yet, and failures are logged, never surfaced to the
 * session. Safe to call again for the same session object.
 */
export function observeSessionAgentEvents(session: MirrorableSession, hub: SessionEventHub): void {
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
  mirrorSessionEvents(session, publisher.emit, { onError: error => warnOnce('mapping an event', error) });
}
