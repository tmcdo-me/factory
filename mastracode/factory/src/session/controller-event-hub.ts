// fork(claude-agent): slice 6. Test support: Factory's event stream for a fake Mastra Code session.
import type { EventEnvelope, RuntimeSessionEvent } from '@factory/agent-runtime';
import { MastraCodeEventMapper } from '@factory/runtime-mastra-code';

interface ControllerSession {
  subscribe(listener: (event: RuntimeSessionEvent) => void): () => void;
  identity?: { getId(): string };
}

const hubs = new WeakMap<object, { sessionId: string; events: { listen: Listen } }>();
type Listen = (sessionId: string, listener: (envelope: EventEnvelope) => void) => () => void;

/**
 * What observers listen to: the session's controller events as Factory's mirror maps them
 * (`MastraCodeEventMapper`), delivered synchronously. One stream per session object, shared by every
 * observer of it. An `agent_end` the session never started is preceded by an `agent_start`, as the
 * real controller always sends one.
 */
export function hubOf(session: ControllerSession): { sessionId: string; events: { listen: Listen } } {
  const known = hubs.get(session);
  if (known) return known;
  const sessionId = session.identity?.getId() ?? 'session';
  const mapper = new MastraCodeEventMapper({ sessionId });
  const listeners = new Set<(envelope: EventEnvelope) => void>();
  let seq = 0;
  let running = false;
  const deliver = (event: RuntimeSessionEvent) => {
    for (const mapped of mapper.map(event as Parameters<typeof mapper.map>[0])) {
      const envelope = { sessionId, seq: ++seq, at: new Date().toISOString(), event: mapped };
      for (const listener of [...listeners]) listener(envelope);
    }
  };
  const stop = session.subscribe(event => {
    if (event.type === 'agent_start') running = true;
    if (event.type === 'agent_end' && !running) deliver({ type: 'agent_start' });
    if (event.type === 'agent_end') running = false;
    deliver(event);
  });
  const hub = {
    sessionId,
    events: {
      listen: ((_id, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          // The last observer leaving ends the stream, as the controller subscription it came from.
          if (listeners.size === 0) {
            stop();
            hubs.delete(session);
          }
        };
      }) as Listen,
    },
  };
  hubs.set(session, hub);
  return hub;
}
