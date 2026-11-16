import type { EventEnvelope, FactoryEvent } from './events';

/** Append-only, per-session event storage. Factory provides a storage-backed implementation. */
export interface EventLog {
  /**
   * Append events for one session, assigning consecutive `seq` numbers after the session's last.
   * Must be atomic per call; callers serialize calls per session.
   */
  append(sessionId: string, events: FactoryEvent[]): Promise<EventEnvelope[]>;
  /** Events with `seq > afterSeq` (default 0), ascending, up to `limit`. */
  list(sessionId: string, options?: { afterSeq?: number; limit?: number }): Promise<EventEnvelope[]>;
}

/** Reference implementation for tests and single-process development. */
export class InMemoryEventLog implements EventLog {
  readonly #sessions = new Map<string, EventEnvelope[]>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async append(sessionId: string, events: FactoryEvent[]): Promise<EventEnvelope[]> {
    const log = this.#sessions.get(sessionId) ?? [];
    this.#sessions.set(sessionId, log);
    const at = this.#now().toISOString();
    const appended = events.map((event, index) => ({ sessionId, seq: log.length + index + 1, at, event }));
    log.push(...appended);
    return appended;
  }

  async list(sessionId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<EventEnvelope[]> {
    const log = this.#sessions.get(sessionId) ?? [];
    const afterSeq = options.afterSeq ?? 0;
    // seq n lives at index n - 1, so the slice starts at afterSeq.
    const rest = log.slice(Math.max(0, afterSeq));
    return options.limit === undefined ? rest : rest.slice(0, options.limit);
  }
}
