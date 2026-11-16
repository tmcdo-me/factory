// fork(claude-agent): Factory's messages to Claude Agent sessions, in this process only.
import { AGENT_MESSAGE_RETENTION_MS, replyClaimId } from './base.js';
import type { AgentMessage, AgentMessageRecord, AgentMessageStatus, AgentMessageStore } from './base.js';

/** How many messages that no longer wait this keeps; past it, the oldest are forgotten. */
const KEPT = 1000;

/**
 * An `AgentMessageStore` in memory, for a server without the `agent-messages` domain (and tests):
 * held messages last until the process does. Bounded: beyond what still waits, it keeps the newest
 * `KEPT` other rows, none older than `AGENT_MESSAGE_RETENTION_MS`.
 */
export class InMemoryAgentMessages implements AgentMessageStore {
  readonly durable = false;
  readonly #rows = new Map<string, AgentMessageRecord>();
  /** Each unconfirmed reply claim's lease, by claim id. */
  readonly #leases = new Map<string, Date>();

  async told(message: AgentMessage): Promise<void> {
    this.#put(message, 'told');
    this.#trim();
  }

  async hold(message: AgentMessage, cap: number): Promise<number> {
    this.#put(message, 'held');
    const held = this.#of(message.sessionId, 'held');
    const over = held.slice(0, Math.max(0, held.length - cap));
    for (const row of over) row.status = 'dropped';
    this.#trim();
    return over.length;
  }

  async take(sessionId: string): Promise<{ messages: AgentMessageRecord[]; dropped: number }> {
    const toldAt = new Date();
    const messages = this.#of(sessionId, 'held');
    for (const row of messages) Object.assign(row, { status: 'told', toldAt });
    const dropped = this.#of(sessionId, 'dropped');
    // A dropped message only ever counts toward one turn's note.
    for (const row of dropped) this.#rows.delete(row.id);
    return { messages: messages.map(row => ({ ...row })), dropped: dropped.length };
  }

  async get(sessionId: string, id: string): Promise<AgentMessageRecord | undefined> {
    const row = this.#rows.get(id);
    return row?.sessionId === sessionId && row.status !== 'claimed' && row.status !== 'answered'
      ? { ...row }
      : undefined;
  }

  async recentOnThread(threadId: string, limit: number): Promise<AgentMessageRecord[]> {
    return [...this.#rows.values()]
      .filter(row => row.delivery?.threadId === threadId)
      .reverse()
      .slice(0, limit)
      .map(row => ({ ...row }));
  }

  async forget(sessionId: string, id: string): Promise<void> {
    if (this.#rows.get(id)?.sessionId === sessionId) this.#rows.delete(id);
  }

  async claimReply(sessionId: string, id: string, leaseUntil: Date): Promise<boolean> {
    const claim = replyClaimId(id, sessionId);
    const held = this.#rows.get(claim);
    if (held && (held.status === 'answered' || (this.#leases.get(claim) ?? new Date(0)) > new Date())) return false;
    this.#put({ id: claim, sessionId, source: 'factory-session', text: '', createdAt: new Date() }, 'claimed');
    this.#leases.set(claim, leaseUntil);
    return true;
  }

  async extendReply(sessionId: string, id: string, leaseUntil: Date): Promise<void> {
    const claim = replyClaimId(id, sessionId);
    if (this.#rows.get(claim)?.status === 'claimed') this.#leases.set(claim, leaseUntil);
  }

  async confirmReply(sessionId: string, id: string): Promise<void> {
    const claim = replyClaimId(id, sessionId);
    const row = this.#rows.get(claim);
    if (row?.status !== 'claimed') return;
    row.status = 'answered';
    this.#leases.delete(claim);
  }

  async releaseReply(sessionId: string, id: string): Promise<void> {
    const claim = replyClaimId(id, sessionId);
    if (this.#rows.get(claim)?.status !== 'claimed') return;
    this.#rows.delete(claim);
    this.#leases.delete(claim);
  }

  async forgetBefore(before: Date): Promise<number> {
    let pruned = 0;
    for (const [id, row] of this.#rows) {
      // A message read by Claude counts from when it read it (see `AGENT_MESSAGE_RETENTION_MS`).
      const since = row.status === 'told' ? (row.toldAt ?? row.createdAt) : row.createdAt;
      if (row.status === 'held' || since >= before) continue;
      this.#rows.delete(id);
      this.#leases.delete(id);
      pruned += 1;
    }
    return pruned;
  }

  #put(message: AgentMessage, status: AgentMessageStatus): void {
    this.#rows.set(message.id, { ...message, status, ...(status === 'told' ? { toldAt: new Date() } : {}) });
  }

  /** The session's rows with `status`, oldest first (insertion order). */
  #of(sessionId: string, status: AgentMessageStatus): AgentMessageRecord[] {
    return [...this.#rows.values()].filter(row => row.sessionId === sessionId && row.status === status);
  }

  /** Past retention, or past `KEPT` of what no longer waits (oldest first), is forgotten. */
  #trim(): void {
    void this.forgetBefore(new Date(Date.now() - AGENT_MESSAGE_RETENTION_MS));
    let kept = [...this.#rows.values()].filter(row => row.status !== 'held').length;
    for (const [id, row] of this.#rows) {
      if (kept <= KEPT) return;
      if (row.status === 'held') continue;
      this.#rows.delete(id);
      this.#leases.delete(id);
      kept -= 1;
    }
  }
}
