import type { InteractionRecord, InteractionStore } from './interactions';

/** Reference implementation for tests and single-process development. */
export class InMemoryInteractionStore implements InteractionStore {
  readonly #records = new Map<string, InteractionRecord>();

  async create(record: InteractionRecord): Promise<void> {
    if (this.#records.has(record.id)) throw new Error(`Interaction ${record.id} already exists`);
    this.#records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<InteractionRecord | undefined> {
    const record = this.#records.get(id);
    return record && structuredClone(record);
  }

  async settle(
    id: string,
    settlement: Parameters<InteractionStore['settle']>[1],
  ): Promise<InteractionRecord | undefined> {
    const record = this.#records.get(id);
    if (!record || record.status !== 'pending') return undefined;
    const settled: InteractionRecord = { ...record, ...settlement };
    this.#records.set(id, settled);
    return structuredClone(settled);
  }

  async listPending(filter: { sessionId?: string } = {}): Promise<InteractionRecord[]> {
    return [...this.#records.values()]
      .filter(record => record.status === 'pending' && (!filter.sessionId || record.sessionId === filter.sessionId))
      .map(record => structuredClone(record));
  }
}
