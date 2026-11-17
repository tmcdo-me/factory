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
  /** `listen` observers: also told of events whose append failed, which `subscribe` clients must never see. */
  readonly #observers = new Map<string, Set<Listener>>();
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
        let envelopes: EventEnvelope[];
        try {
          envelopes = await this.#log.append(sessionId, events);
        } catch (error) {
          // Storage failed: observers still hear what happened (a run's end must not go unreported),
          // as unstored envelopes (`seq` 0). `subscribe` clients replay from the log, so they never do.
          const at = new Date().toISOString();
          for (const event of events) this.#notify(this.#observers, { sessionId, seq: 0, at, event });
          throw error;
        }
        for (const envelope of envelopes) {
          this.#notify(this.#observers, envelope);
          this.#notify(this.#listeners, envelope);
        }
        return envelopes;
      });
    this.#tails.set(sessionId, next);
    const cleanup = () => {
      if (this.#tails.get(sessionId) === next) this.#tails.delete(sessionId);
    };
    // Settle-only handler: the caller still receives the rejection through `next`.
    next.then(cleanup, cleanup);
    return next;
  }

  #notify(registry: Map<string, Set<Listener>>, envelope: EventEnvelope): void {
    for (const listener of [...(registry.get(envelope.sessionId) ?? [])]) listener(envelope);
  }

  /**
   * Call `listener` with each event published for the session from now on, in order, once it is
   * stored (nothing is replayed). If storing fails, the listener still hears the events, with `seq` 0. Returns the function that stops listening. A listener that
   * throws is reported and skipped: it never fails the publish or the other listeners.
   */
  listen(sessionId: string, listener: (envelope: EventEnvelope) => void): () => void {
    const safe: Listener = envelope => {
      try {
        listener(envelope);
      } catch (error) {
        console.warn(`[factory] event listener for session ${sessionId} failed.`, error);
      }
    };
    const listeners = this.#observers.get(sessionId) ?? new Set<Listener>();
    this.#observers.set(sessionId, listeners);
    listeners.add(safe);
    return () => {
      listeners.delete(safe);
      if (listeners.size === 0 && this.#observers.get(sessionId) === listeners) this.#observers.delete(sessionId);
    };
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
