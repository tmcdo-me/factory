// fork(claude-agent): storage-backed InteractionStore for the agent runtime seam.
import type {
  InteractionRecord,
  InteractionRequest,
  InteractionResponse,
  InteractionStore,
} from '@factory/agent-runtime';
import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

const COLLECTION = 'factory_agent_interactions';

export const AGENT_INTERACTIONS_SCHEMA: CollectionSchema = {
  name: COLLECTION,
  columns: {
    id: { type: 'text', primaryKey: true },
    session_id: { type: 'text' },
    call_id: { type: 'text', nullable: true },
    request: { type: 'json' },
    status: { type: 'text' },
    response: { type: 'json', nullable: true },
    resolved_by: { type: 'text', nullable: true },
    cancel_reason: { type: 'text', nullable: true },
    requested_at: { type: 'timestamp' },
    settled_at: { type: 'timestamp', nullable: true },
    // The runtime that holds the call and takes its answer (Mastra Code's controller), if not the broker.
    held_by: { type: 'text', nullable: true },
  },
  indexes: [{ name: 'factory_agent_interactions_session_status_idx', columns: ['session_id', 'status'] }],
};

interface AgentInteractionRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  call_id: string | null;
  request: InteractionRequest;
  status: InteractionRecord['status'];
  response: InteractionResponse | null;
  resolved_by: string | null;
  cancel_reason: string | null;
  requested_at: Date;
  settled_at: Date | null;
  held_by?: string | null;
}

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

function toRecord(row: AgentInteractionRow): InteractionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.call_id ? { callId: row.call_id } : {}),
    request: row.request,
    requestedAt: iso(row.requested_at),
    status: row.status,
    ...(row.response ? { response: row.response } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.settled_at ? { settledAt: iso(row.settled_at) } : {}),
    ...(row.held_by ? { heldBy: row.held_by } : {}),
  };
}

/** Pending and settled human interactions (`@factory/agent-runtime`'s `InteractionStore`). */
export class AgentInteractionsStorage extends FactoryStorageDomain implements InteractionStore {
  constructor() {
    super('agent-interactions');
  }

  async init(): Promise<void> {
    await this.ensureCollections([AGENT_INTERACTIONS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(COLLECTION, {});
  }

  async create(record: InteractionRecord): Promise<void> {
    await this.ops.insertOne<AgentInteractionRow>(COLLECTION, {
      id: record.id,
      session_id: record.sessionId,
      call_id: record.callId ?? null,
      request: record.request,
      status: record.status,
      response: record.response ?? null,
      resolved_by: record.resolvedBy ?? null,
      cancel_reason: record.cancelReason ?? null,
      requested_at: new Date(record.requestedAt),
      settled_at: record.settledAt ? new Date(record.settledAt) : null,
      // Only a held record writes the column, so a table it couldn't be added to still takes Claude Agent's.
      ...(record.heldBy ? { held_by: record.heldBy } : {}),
    });
  }

  async get(id: string): Promise<InteractionRecord | undefined> {
    const row = await this.ops.findOne<AgentInteractionRow>(COLLECTION, { id });
    return row ? toRecord(row) : undefined;
  }

  async settle(
    id: string,
    settlement: Parameters<InteractionStore['settle']>[1],
  ): Promise<InteractionRecord | undefined> {
    let settled = false;
    const row = await this.ops.updateAtomic<AgentInteractionRow>(COLLECTION, { id }, current => {
      if (current.status !== 'pending') return null;
      settled = true;
      return settlement.status === 'resolved'
        ? {
            status: 'resolved',
            response: settlement.response,
            resolved_by: settlement.resolvedBy ?? null,
            settled_at: new Date(settlement.settledAt),
          }
        : { status: 'cancelled', cancel_reason: settlement.cancelReason, settled_at: new Date(settlement.settledAt) };
    });
    return row && settled ? toRecord(row) : undefined;
  }

  async listPending(filter: { sessionId?: string } = {}): Promise<InteractionRecord[]> {
    const rows = await this.ops.findMany<AgentInteractionRow>(
      COLLECTION,
      { status: 'pending', ...(filter.sessionId ? { session_id: filter.sessionId } : {}) },
      { orderBy: [['requested_at', 'asc']] },
    );
    return rows.map(toRecord);
  }
}
