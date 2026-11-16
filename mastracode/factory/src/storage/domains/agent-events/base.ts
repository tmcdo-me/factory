// fork(claude-agent): storage-backed EventLog for the agent runtime seam.
import type { EventEnvelope, EventLog, FactoryEvent } from '@factory/agent-runtime';
import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

const COLLECTION = 'factory_agent_events';

export const AGENT_EVENTS_SCHEMA: CollectionSchema = {
  name: COLLECTION,
  columns: {
    id: { type: 'uuid-pk' },
    session_id: { type: 'text' },
    seq: { type: 'integer' },
    at: { type: 'timestamp' },
    event: { type: 'json' },
  },
  uniqueIndexes: [{ name: 'factory_agent_events_session_seq_key', columns: ['session_id', 'seq'] }],
};

interface AgentEventRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  seq: number;
  at: Date;
  event: FactoryEvent;
}

/** Attempts per event when another writer (e.g. a second replica) takes the same `seq`. */
const MAX_APPEND_ATTEMPTS = 5;

function toEnvelope(row: AgentEventRow): EventEnvelope {
  return {
    sessionId: row.session_id,
    seq: Number(row.seq),
    at: (row.at instanceof Date ? row.at : new Date(row.at as unknown as string)).toISOString(),
    event: row.event,
  };
}

/** Append-only per-session event log (`@factory/agent-runtime`'s `EventLog`). */
export class AgentEventsStorage extends FactoryStorageDomain implements EventLog {
  constructor() {
    super('agent-events');
  }

  async init(): Promise<void> {
    await this.ensureCollections([AGENT_EVENTS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(COLLECTION, {});
  }

  async append(sessionId: string, events: FactoryEvent[]): Promise<EventEnvelope[]> {
    const appended: EventEnvelope[] = [];
    let last = await this.#lastSeq(sessionId);
    for (const event of events) {
      for (let attempt = 1; ; attempt++) {
        try {
          const row = await this.ops.insertOne<AgentEventRow>(COLLECTION, {
            session_id: sessionId,
            seq: last + 1,
            at: new Date(),
            event,
          });
          last += 1;
          appended.push(toEnvelope(row));
          break;
        } catch (error) {
          if (!(error instanceof UniqueViolationError) || attempt >= MAX_APPEND_ATTEMPTS) throw error;
          last = await this.#lastSeq(sessionId);
        }
      }
    }
    return appended;
  }

  async list(sessionId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<EventEnvelope[]> {
    const rows = await this.ops.findMany<AgentEventRow>(
      COLLECTION,
      { session_id: sessionId },
      {
        orderBy: [['seq', 'asc']],
        ...(options.afterSeq ? { cursor: { values: [options.afterSeq] } } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
    );
    return rows.map(toEnvelope);
  }

  /** Remove a session's events (session deleted). */
  async deleteSession(sessionId: string): Promise<number> {
    return this.ops.deleteMany(COLLECTION, { session_id: sessionId });
  }

  async #lastSeq(sessionId: string): Promise<number> {
    const [row] = await this.ops.findMany<AgentEventRow>(
      COLLECTION,
      { session_id: sessionId },
      { orderBy: [['seq', 'desc']], limit: 1 },
    );
    return row ? Number(row.seq) : 0;
  }
}
