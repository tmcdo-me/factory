import { randomUUID } from 'node:crypto';

import type { SessionEventHub } from './event-hub';
import type {
  InteractionKind,
  InteractionRecord,
  InteractionRequest,
  InteractionResponse,
  InteractionStore,
  ResponseFor,
} from './interactions';

export class InteractionCancelledError extends Error {
  readonly interactionId: string;
  readonly reason: string;
  constructor(interactionId: string, reason: string) {
    super(`Interaction ${interactionId} was cancelled: ${reason}`);
    this.name = 'InteractionCancelledError';
    this.interactionId = interactionId;
    this.reason = reason;
  }
}

export type ResolveOutcome =
  /** A live waiter received the answer. */
  | { status: 'delivered'; record: InteractionRecord }
  /** Nobody was waiting (e.g. after a restart); `onUndelivered` was called to re-deliver it. */
  | { status: 'queued'; record: InteractionRecord }
  /** Missing, already answered, or cancelled. */
  | { status: 'not_pending' };

interface Waiter {
  resolve(response: InteractionResponse): void;
  reject(error: Error): void;
}

export interface InteractionBrokerOptions {
  store: InteractionStore;
  hub: SessionEventHub;
  /**
   * Called when an answer arrives and no live waiter exists, typically because the server restarted
   * while the human was deciding. Factory reopens the session and sends an `interaction_response`.
   */
  onUndelivered?(record: InteractionRecord): Promise<void>;
  newId?: () => string;
  now?: () => Date;
}

/**
 * Factory-owned human-in-the-loop. Tools ask with `request()`; the UI, other sessions and board
 * auto-approval answer with `resolve()`. State lives in the `InteractionStore`, so pending
 * interactions survive restarts; live waiters are an in-process optimisation on top.
 */
export class InteractionBroker {
  readonly #store: InteractionStore;
  readonly #hub: SessionEventHub;
  readonly #onUndelivered: InteractionBrokerOptions['onUndelivered'];
  readonly #newId: () => string;
  readonly #now: () => Date;
  readonly #waiters = new Map<string, Waiter>();

  constructor(options: InteractionBrokerOptions) {
    this.#store = options.store;
    this.#hub = options.hub;
    this.#onUndelivered = options.onUndelivered;
    this.#newId = options.newId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  /** Ask the human and wait for the answer. Rejects with `InteractionCancelledError` on cancel/abort. */
  async request<K extends InteractionKind>(
    sessionId: string,
    request: Extract<InteractionRequest, { kind: K }>,
    options: { callId?: string; signal?: AbortSignal } = {},
  ): Promise<ResponseFor<K>> {
    const { callId, signal } = options;
    if (signal?.aborted) throw new InteractionCancelledError('(not created)', 'aborted');

    const record: InteractionRecord = {
      id: this.#newId(),
      sessionId,
      callId,
      request,
      requestedAt: this.#now().toISOString(),
      status: 'pending',
    };

    // Register the waiter first so an answer that races the publish is still delivered live.
    const answer = new Promise<InteractionResponse>((resolve, reject) => {
      this.#waiters.set(record.id, { resolve, reject });
    });
    const onAbort = () => void this.cancel(record.id, 'aborted');
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await this.#store.create(record);
      const { status: _status, ...pending } = record;
      await this.#hub.publish(sessionId, { type: 'interaction.requested', interaction: pending });
      return (await answer) as ResponseFor<K>;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#waiters.delete(record.id);
    }
  }

  async resolve(
    id: string,
    response: InteractionResponse,
    options: { resolvedBy?: string } = {},
  ): Promise<ResolveOutcome> {
    const existing = await this.#store.get(id);
    if (!existing || existing.status !== 'pending') return { status: 'not_pending' };
    if (existing.request.kind !== response.kind) {
      throw new Error(`Interaction ${id} expects a "${existing.request.kind}" response, got "${response.kind}"`);
    }

    const record = await this.#store.settle(id, {
      status: 'resolved',
      response,
      resolvedBy: options.resolvedBy,
      settledAt: this.#now().toISOString(),
    });
    if (!record) return { status: 'not_pending' }; // lost a race with another answer or a cancel

    await this.#hub.publish(record.sessionId, {
      type: 'interaction.resolved',
      interactionId: id,
      response,
      resolvedBy: options.resolvedBy,
    });

    const waiter = this.#waiters.get(id);
    if (waiter) {
      waiter.resolve(response);
      return { status: 'delivered', record };
    }
    await this.#onUndelivered?.(record);
    return { status: 'queued', record };
  }

  /** Cancel one pending interaction. Returns false when it was not pending. */
  async cancel(id: string, reason: string): Promise<boolean> {
    const record = await this.#store.settle(id, {
      status: 'cancelled',
      cancelReason: reason,
      settledAt: this.#now().toISOString(),
    });
    if (!record) return false;
    await this.#hub.publish(record.sessionId, { type: 'interaction.cancelled', interactionId: id, reason });
    this.#waiters.get(id)?.reject(new InteractionCancelledError(id, reason));
    return true;
  }

  /** Cancel everything pending for a session (abort, close). Returns how many were cancelled. */
  async cancelSession(sessionId: string, reason: string): Promise<number> {
    const pending = await this.#store.listPending({ sessionId });
    let cancelled = 0;
    for (const record of pending) {
      if (await this.cancel(record.id, reason)) cancelled++;
    }
    return cancelled;
  }

  listPending(filter?: { sessionId?: string }): Promise<InteractionRecord[]> {
    return this.#store.listPending(filter);
  }

  /** Whether this process has a live waiter for the interaction. */
  isWaiting(id: string): boolean {
    return this.#waiters.has(id);
  }
}
