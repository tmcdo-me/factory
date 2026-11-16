import type { EventLog } from './event-log';
import type { EventEnvelope, FactoryEvent } from './events';

type Listener = (envelope: EventEnvelope) => void;

/**
 * Persists session events and fans them out to subscribers.
 *
 * `publish` appends to the log in order (serialized per session), then notifies live listeners.
 * `subscribe` replays everything after `afterSeq` from the log, then continues with live events,
 * without gaps or duplicates — so an SSE client can reconnect with its last seen `seq`.
 *
 * In-process only. Cross-replica fan-out (pubsub) wraps this later.
 */
export class SessionEventHub {
  readonly #log: EventLog;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(log: EventLog) {
    this.#log = log;
  }

  get log(): EventLog {
    return this.#log;
  }

  /** Append events for a session and notify subscribers. Resolves with the stored envelopes. */
  publish(sessionId: string, ...events: FactoryEvent[]): Promise<EventEnvelope[]> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const envelopes = await this.#log.append(sessionId, events);
        for (const envelope of envelopes) {
          for (const listener of this.#listeners.get(sessionId) ?? []) listener(envelope);
        }
        return envelopes;
      });
    this.#tails.set(sessionId, next);
    void next.finally(() => {
      if (this.#tails.get(sessionId) === next) this.#tails.delete(sessionId);
    });
    return next;
  }

  /** Stored events after `afterSeq`, then live events, until `signal` aborts. */
  async *subscribe(
    sessionId: string,
    options: { afterSeq?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<EventEnvelope, void, undefined> {
    const { signal } = options;
    let lastSeq = options.afterSeq ?? 0;
    const buffer: EventEnvelope[] = [];
    let wake: (() => void) | undefined;

    // Listen before replaying so nothing published during the replay is missed.
    const listener: Listener = envelope => {
      buffer.push(envelope);
      wake?.();
    };
    const onAbort = () => wake?.();
    const listeners = this.#listeners.get(sessionId) ?? new Set<Listener>();
    this.#listeners.set(sessionId, listeners);
    listeners.add(listener);
    signal?.addEventListener('abort', onAbort);

    try {
      for (const envelope of await this.#log.list(sessionId, { afterSeq: lastSeq })) {
        if (signal?.aborted) return;
        lastSeq = envelope.seq;
        yield envelope;
      }
      while (!signal?.aborted) {
        const envelope = buffer.shift();
        if (!envelope) {
          await new Promise<void>(resolve => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        if (envelope.seq <= lastSeq) continue; // already replayed
        lastSeq = envelope.seq;
        yield envelope;
      }
    } finally {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
