// fork(claude-agent): Factory's messages to Claude Agent sessions, in this process only.
import type { AgentMessage, AgentMessageRecord, AgentMessageStatus, AgentMessageStore } from './base.js';

/** How many messages Claude already read this keeps; past it, the oldest are forgotten. */
const TOLD_KEPT = 1000;

/**
 * An `AgentMessageStore` in memory, for a server without the `agent-messages` domain (and tests):
 * held messages last until the process does. Bounded: only messages still waiting are kept beyond
 * the newest `TOLD_KEPT` read ones.
 */
export class InMemoryAgentMessages implements AgentMessageStore {
  readonly #rows = new Map<string, AgentMessageRecord>();

  async told(message: AgentMessage): Promise<void> {
    this.#put(message, 'told');
    this.#prune();
  }

  async hold(message: AgentMessage, cap: number): Promise<number> {
    this.#put(message, 'held');
    const held = this.#of(message.sessionId, 'held');
    const over = held.slice(0, Math.max(0, held.length - cap));
    for (const row of over) row.status = 'dropped';
    return over.length;
  }

  async take(sessionId: string): Promise<{ messages: AgentMessageRecord[]; dropped: number }> {
    const toldAt = new Date();
    const messages = this.#of(sessionId, 'held');
    for (const row of messages) Object.assign(row, { status: 'told', toldAt });
    const dropped = this.#of(sessionId, 'dropped');
    // A dropped message only ever counts toward one turn's note.
    for (const row of dropped) this.#rows.delete(row.id);
    this.#prune();
    return { messages: messages.map(row => ({ ...row })), dropped: dropped.length };
  }

  async get(sessionId: string, id: string): Promise<AgentMessageRecord | undefined> {
    const row = this.#rows.get(id);
    return row?.sessionId === sessionId ? { ...row } : undefined;
  }

  async recentOnThread(threadId: string, limit: number): Promise<AgentMessageRecord[]> {
    return [...this.#rows.values()]
      .filter(row => row.delivery?.threadId === threadId)
      .reverse()
      .slice(0, limit)
      .map(row => ({ ...row }));
  }

  #put(message: AgentMessage, status: AgentMessageStatus): void {
    this.#rows.set(message.id, { ...message, status, ...(status === 'told' ? { toldAt: new Date() } : {}) });
  }

  /** The session's rows with `status`, oldest first (insertion order). */
  #of(sessionId: string, status: AgentMessageStatus): AgentMessageRecord[] {
    return [...this.#rows.values()].filter(row => row.sessionId === sessionId && row.status === status);
  }

  #prune(): void {
    let told = [...this.#rows.values()].filter(row => row.status === 'told').length;
    for (const [id, row] of this.#rows) {
      if (told <= TOLD_KEPT) return;
      if (row.status !== 'told') continue;
      this.#rows.delete(id);
      told -= 1;
    }
  }
}
