// fork(claude-agent): Factory's messages to sessions on another agent runtime (Claude Agent).
import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

const COLLECTION = 'factory_agent_messages';

export const AGENT_MESSAGES_SCHEMA: CollectionSchema = {
  name: COLLECTION,
  columns: {
    id: { type: 'text', primaryKey: true },
    session_id: { type: 'text' },
    source: { type: 'text' },
    text: { type: 'text' },
    attributes: { type: 'json', nullable: true },
    thread_id: { type: 'text', nullable: true },
    kind: { type: 'text', nullable: true },
    priority: { type: 'text', nullable: true },
    source_id: { type: 'text', nullable: true },
    status: { type: 'text' },
    created_at: { type: 'timestamp' },
    told_at: { type: 'timestamp', nullable: true },
    /** A reply claim's lease: past it, an unconfirmed claim no longer holds. */
    lease_until: { type: 'timestamp', nullable: true },
  },
  indexes: [
    { name: 'factory_agent_messages_session_status_idx', columns: ['session_id', 'status'] },
    { name: 'factory_agent_messages_thread_created_idx', columns: ['thread_id', 'created_at'] },
    { name: 'factory_agent_messages_status_created_idx', columns: ['status', 'created_at'] },
    { name: 'factory_agent_messages_status_told_idx', columns: ['status', 'told_at'] },
  ],
};

/**
 * `held`: waits for the session's next turn. `told`: Claude read it with a turn. `dropped`: more
 * waited than a session keeps, so it never will (its turn says how many were dropped). `claimed`
 * and `answered` are not messages but the mark that a session is answering one (`claimReply`,
 * leased) or answered it (`confirmReply`).
 */
export type AgentMessageStatus = 'held' | 'told' | 'dropped' | 'claimed' | 'answered';

/**
 * How long a message is kept once Claude read it (from `told_at`; a held message is kept until a
 * turn takes it, however long that is). It is the reply window too: a Claude Agent session can
 * answer a message for 7 days after it read it. Mastra Code's notification records have no such
 * limit; this keeps the table bounded, well past the 10-minute rate-limit window.
 */
export const AGENT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a process sweeps out messages past retention. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const PRUNE_BATCH = 200;

/** The mark that `sessionId` answered message `id`. */
export const replyClaimId = (id: string, sessionId: string) => `reply:${id}:${sessionId}`;

/** A session-to-session notification a message carries, as Factory's messaging tools read it back. */
export interface AgentMessageDelivery {
  /** The thread the notification was addressed to. */
  threadId: string;
  kind: string;
  priority: string;
  /** The sending session. */
  sourceId?: string;
}

/** One Factory message to a session: what Claude reads, and, for a notification, what it was. */
export interface AgentMessage {
  /** The id Claude sees, and answers with. */
  id: string;
  sessionId: string;
  /** Who it is from, as Claude reads it (`factory-session`, `rule-message`, `source-activity`). */
  source: string;
  text: string;
  /** What the message says about itself, shown to Claude with it. */
  attributes?: Record<string, string | number | boolean>;
  delivery?: AgentMessageDelivery;
  createdAt: Date;
}

export interface AgentMessageRecord extends AgentMessage {
  status: AgentMessageStatus;
  toldAt?: Date;
}

/**
 * Where a session's Factory messages wait for its next turn, durably, and what it was told: a
 * session can answer a message it read, and a sender's rate limit counts what it sent.
 */
export interface AgentMessageStore {
  /** Whether what it keeps survives a restart. */
  readonly durable: boolean;
  /** Keep a message the session reads with the turn it starts now. */
  told(message: AgentMessage): Promise<void>;
  /** Keep a message for the session's next turn. Past `cap` waiting, the oldest are dropped; resolves with how many. */
  hold(message: AgentMessage, cap: number): Promise<number>;
  /**
   * The messages waiting for the session's turn, oldest first, and how many were dropped unread
   * since it last heard. Each is handed out once, even to two turns taking at the same time.
   */
  take(sessionId: string): Promise<{ messages: AgentMessageRecord[]; dropped: number }>;
  /** A notification this session was sent. */
  get(sessionId: string, id: string): Promise<AgentMessageRecord | undefined>;
  /** The newest notifications addressed to a thread, newest first. */
  recentOnThread(threadId: string, limit: number): Promise<AgentMessageRecord[]>;
  /** Forget a message kept for a turn that never started. */
  forget(sessionId: string, id: string): Promise<void>;
  /**
   * Take the right to answer message `id` from `sessionId` until `leaseUntil`: false while another
   * answer holds it (even one racing this call) or has been confirmed. A claim never confirmed
   * (the server stopped first, a queued answer was lost) lapses at its lease.
   */
  claimReply(sessionId: string, id: string, leaseUntil: Date): Promise<boolean>;
  /** Hold an unconfirmed claim longer (an answer queued past the rate limit). */
  extendReply(sessionId: string, id: string, leaseUntil: Date): Promise<void>;
  /** The answer went out: the claim holds for good. */
  confirmReply(sessionId: string, id: string): Promise<void>;
  /** Give an unconfirmed claim back, when the answer could not be sent. */
  releaseReply(sessionId: string, id: string): Promise<void>;
  /** Forget what no longer waits and went out of use before `before` (a message: when Claude read it). */
  forgetBefore(before: Date): Promise<number>;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  source: string;
  text: string;
  attributes: Record<string, string | number | boolean> | null;
  thread_id: string | null;
  kind: string | null;
  priority: string | null;
  source_id: string | null;
  status: AgentMessageStatus;
  created_at: Date;
  told_at: Date | null;
  lease_until?: Date | null;
}

function toRecord(row: MessageRow): AgentMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    text: row.text,
    ...(row.attributes ? { attributes: row.attributes } : {}),
    ...(row.thread_id && row.kind && row.priority
      ? {
          delivery: {
            threadId: row.thread_id,
            kind: row.kind,
            priority: row.priority,
            ...(row.source_id ? { sourceId: row.source_id } : {}),
          },
        }
      : {}),
    status: row.status,
    createdAt: new Date(row.created_at),
    ...(row.told_at ? { toldAt: new Date(row.told_at) } : {}),
  };
}

function toRow(message: AgentMessage, status: AgentMessageStatus, toldAt: Date | null): MessageRow {
  return {
    id: message.id,
    session_id: message.sessionId,
    source: message.source,
    text: message.text,
    attributes: message.attributes ?? null,
    thread_id: message.delivery?.threadId ?? null,
    kind: message.delivery?.kind ?? null,
    priority: message.delivery?.priority ?? null,
    source_id: message.delivery?.sourceId ?? null,
    status,
    created_at: message.createdAt,
    told_at: toldAt,
    lease_until: null,
  };
}

/** Oldest first; two messages kept in one millisecond keep the order they came in. */
const OLDEST_FIRST: [string, 'asc' | 'desc'][] = [
  ['created_at', 'asc'],
  ['id', 'asc'],
];

/** `AgentMessageStore` on Factory's storage. */
export class AgentMessagesStorage extends FactoryStorageDomain implements AgentMessageStore {
  readonly durable = true;
  #prunedAt = 0;

  constructor() {
    super('agent-messages');
  }

  async init(): Promise<void> {
    await this.ensureCollections([AGENT_MESSAGES_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(COLLECTION, {});
  }

  async told(message: AgentMessage): Promise<void> {
    await this.ops.insertOne<MessageRow>(COLLECTION, toRow(message, 'told', new Date()));
    this.#sweep();
  }

  async hold(message: AgentMessage, cap: number): Promise<number> {
    await this.ops.insertOne<MessageRow>(COLLECTION, toRow(message, 'held', null));
    this.#sweep();
    const held = await this.ops.findMany<MessageRow>(
      COLLECTION,
      { session_id: message.sessionId, status: 'held' },
      { orderBy: OLDEST_FIRST },
    );
    let dropped = 0;
    for (const row of held.slice(0, Math.max(0, held.length - cap))) {
      if (await this.#move(row.id, 'held', { status: 'dropped' })) dropped += 1;
    }
    return dropped;
  }

  async take(sessionId: string): Promise<{ messages: AgentMessageRecord[]; dropped: number }> {
    const at = new Date();
    const held = await this.ops.findMany<MessageRow>(
      COLLECTION,
      { session_id: sessionId, status: 'held' },
      { orderBy: OLDEST_FIRST },
    );
    const messages: AgentMessageRecord[] = [];
    for (const row of held) {
      const taken = await this.#move(row.id, 'held', { status: 'told', told_at: at });
      if (taken) messages.push(toRecord(taken));
    }
    // A dropped message is reported once: its `told_at` marks the turn that said so.
    const unreported = await this.ops.findMany<MessageRow>(COLLECTION, {
      session_id: sessionId,
      status: 'dropped',
      told_at: null,
    });
    let dropped = 0;
    for (const row of unreported) {
      if (await this.#move(row.id, 'dropped', { told_at: at }, true)) dropped += 1;
    }
    return { messages, dropped };
  }

  async get(sessionId: string, id: string): Promise<AgentMessageRecord | undefined> {
    const row = await this.ops.findOne<MessageRow>(COLLECTION, { session_id: sessionId, id });
    return row && row.status !== 'claimed' && row.status !== 'answered' ? toRecord(row) : undefined;
  }

  async recentOnThread(threadId: string, limit: number): Promise<AgentMessageRecord[]> {
    const rows = await this.ops.findMany<MessageRow>(
      COLLECTION,
      { thread_id: threadId },
      {
        orderBy: [
          ['created_at', 'desc'],
          ['id', 'desc'],
        ],
        limit,
      },
    );
    return rows.map(toRecord);
  }

  async forget(sessionId: string, id: string): Promise<void> {
    await this.ops.deleteMany(COLLECTION, { session_id: sessionId, id });
  }

  async claimReply(sessionId: string, id: string, leaseUntil: Date): Promise<boolean> {
    const claim = replyClaimId(id, sessionId);
    try {
      // The claim's id is the unique key: of two answers racing, one insert wins.
      await this.ops.insertOne<MessageRow>(COLLECTION, {
        id: claim,
        session_id: sessionId,
        source: 'factory-session',
        text: '',
        attributes: null,
        thread_id: null,
        kind: null,
        priority: null,
        source_id: null,
        status: 'claimed',
        created_at: new Date(),
        told_at: null,
        lease_until: leaseUntil,
      });
      return true;
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
    // Held already: taken over only when that claim lapsed, atomically, so one of two takers wins.
    let taken = false;
    await this.ops.updateAtomic<MessageRow>(COLLECTION, { id: claim }, current => {
      const lapsed =
        current.status === 'claimed' && (!current.lease_until || new Date(current.lease_until) <= new Date());
      if (!lapsed) return null;
      taken = true;
      return { lease_until: leaseUntil, created_at: new Date() };
    });
    return taken;
  }

  async extendReply(sessionId: string, id: string, leaseUntil: Date): Promise<void> {
    await this.ops.updateMany(
      COLLECTION,
      { id: replyClaimId(id, sessionId), status: 'claimed' },
      { lease_until: leaseUntil },
    );
  }

  async confirmReply(sessionId: string, id: string): Promise<void> {
    await this.ops.updateMany(
      COLLECTION,
      { id: replyClaimId(id, sessionId), status: 'claimed' },
      { status: 'answered', lease_until: null },
    );
  }

  async releaseReply(sessionId: string, id: string): Promise<void> {
    await this.ops.deleteMany(COLLECTION, {
      session_id: sessionId,
      id: replyClaimId(id, sessionId),
      status: 'claimed',
    });
  }

  async forgetBefore(before: Date): Promise<number> {
    // A message read by Claude counts from when it read it: held a week on an idle card, it can
    // still be answered right after its turn. Dropped messages and reply marks count from creation.
    return (
      (await this.#forgetOldest({ status: 'told' }, 'told_at', before)) +
      (await this.#forgetOldest({ status: { in: ['dropped', 'claimed', 'answered'] } }, 'created_at', before))
    );
  }

  /** Oldest first by `column`, a batch at a time: the query surface filters by equality only. */
  async #forgetOldest(
    where: Record<string, string | { in: string[] }>,
    column: 'told_at' | 'created_at',
    before: Date,
  ): Promise<number> {
    let forgotten = 0;
    for (;;) {
      const batch = await this.ops.findMany<MessageRow>(COLLECTION, where, {
        orderBy: [
          [column, 'asc'],
          ['id', 'asc'],
        ],
        limit: PRUNE_BATCH,
      });
      const old = batch.filter(row => row[column] && new Date(row[column]) < before).map(row => row.id);
      if (old.length) forgotten += await this.ops.deleteMany(COLLECTION, { id: { in: old } });
      if (old.length < PRUNE_BATCH) return forgotten;
    }
  }

  /** Now and then, forget what is past retention. Never holds up the write that triggered it. */
  #sweep(): void {
    const now = Date.now();
    if (now - this.#prunedAt < PRUNE_EVERY_MS) return;
    this.#prunedAt = now;
    void this.forgetBefore(new Date(now - AGENT_MESSAGE_RETENTION_MS)).catch(error =>
      console.warn('[factory] Forgetting old Claude Agent messages failed', error),
    );
  }

  /** Move one row on from `status`, atomically: undefined when another caller got there first. */
  async #move(
    id: string,
    status: AgentMessageStatus,
    set: Partial<MessageRow>,
    unreported = false,
  ): Promise<MessageRow | undefined> {
    let moved = false;
    const row = await this.ops.updateAtomic<MessageRow>(COLLECTION, { id }, current => {
      if (current.status !== status || (unreported && current.told_at)) return null;
      moved = true;
      return set;
    });
    return moved && row ? row : undefined;
  }
}
