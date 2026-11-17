import { randomUUID } from 'node:crypto';

import type { CommandFailure, CommandResult } from './commands';
import type { SessionEventHub } from './event-hub';
import type {
  AnswerableKind,
  AnswerableRequest,
  InteractionRecord,
  InteractionResponse,
  InteractionStore,
  PendingInteraction,
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

/**
 * The runtime holding an interaction (`heldBy`) refused an answer for a reason other than "nothing
 * is pending": its session is gone or can't be read, or the answer doesn't fit.
 */
export class InteractionAnswerRefusedError extends Error {
  readonly interactionId: string;
  readonly reason: Exclude<CommandFailure, 'not_pending'>;
  /** What the runtime said, for the person who answered. */
  readonly detail: string | undefined;
  constructor(interactionId: string, reason: Exclude<CommandFailure, 'not_pending'>, detail?: string) {
    super(`The answer to interaction ${interactionId} was refused (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'InteractionAnswerRefusedError';
    this.interactionId = interactionId;
    this.reason = reason;
    this.detail = detail;
  }
}

/** How an interaction a runtime holds was settled there, as the runtime reports it. */
export type HeldSettlement =
  | { status: 'resolved'; response: InteractionResponse; resolvedBy?: string }
  | { status: 'cancelled'; reason: string };

/** What the broker says when a runtime that holds an interaction reports nothing pending for it any more. */
export const HELD_INTERACTION_GONE = 'The session no longer waits on it.';

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
  /**
   * Hands an answer to the runtime that holds the interaction (`record.heldBy`). The runtime is the
   * authority: the broker settles the record only once it accepts, and a `not_pending` from it means
   * the interaction is gone. `context` is the host's request context for the answer, untouched.
   */
  answerHeld?(
    record: InteractionRecord,
    response: InteractionResponse,
    options: { resolvedBy?: string; context?: unknown },
  ): Promise<CommandResult>;
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
  readonly #answerHeld: InteractionBrokerOptions['answerHeld'];
  /**
   * Held interactions whose answer is with their runtime right now, with how the runtime settled one
   * meanwhile (its events can say so before its answer returns).
   */
  readonly #answering = new Map<string, HeldSettlement | undefined>();
  /**
   * Who answered a held interaction in its own session, as the host saw the answer go to the runtime
   * (`attribute`), until the runtime reports it settled.
   */
  readonly #attributions = new Map<string, { resolvedBy?: string }>();
  readonly #newId: () => string;
  readonly #now: () => Date;
  readonly #waiters = new Map<string, Waiter>();

  constructor(options: InteractionBrokerOptions) {
    this.#store = options.store;
    this.#hub = options.hub;
    this.#onUndelivered = options.onUndelivered;
    this.#answerHeld = options.answerHeld;
    this.#newId = options.newId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  /** Ask the human and wait for the answer. Rejects with `InteractionCancelledError` on cancel/abort. */
  async request<K extends AnswerableKind>(
    sessionId: string,
    request: Extract<AnswerableRequest, { kind: K }>,
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

  /**
   * Answer a pending interaction. One a runtime holds (`heldBy`) is answered through `answerHeld`
   * and settled once the runtime accepts; `context` is passed to it untouched.
   */
  async resolve(
    id: string,
    response: InteractionResponse,
    options: { resolvedBy?: string; context?: unknown } = {},
  ): Promise<ResolveOutcome> {
    const existing = await this.#store.get(id);
    if (!existing || existing.status !== 'pending') return { status: 'not_pending' };
    if (existing.request.kind !== response.kind) {
      throw new Error(`Interaction ${id} expects a "${existing.request.kind}" response, got "${response.kind}"`);
    }
    if (existing.heldBy) return this.#resolveHeld(existing, response, options);

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

  /**
   * Record an interaction a runtime holds itself (`heldBy`), as the runtime reports it. The runtime
   * announced it on the session's own event stream, so the broker publishes nothing. Reporting the
   * same pending call again returns the record already kept; a call id reused after its earlier
   * interaction settled gets an id of its own (`<id>#2`, …).
   */
  async track(interaction: PendingInteraction & { heldBy: string }): Promise<InteractionRecord> {
    if (interaction.callId) {
      const kept = (await this.#store.listPending({ sessionId: interaction.sessionId })).find(
        record => record.heldBy === interaction.heldBy && record.callId === interaction.callId,
      );
      if (kept) return this.#reported(kept);
    }
    let id = interaction.id;
    for (let n = 2; ; n++) {
      const existing = await this.#store.get(id);
      if (!existing) break;
      if (existing.status === 'pending') return this.#reported(existing);
      id = `${interaction.id}#${n}`;
    }
    const record: InteractionRecord = { ...interaction, id, status: 'pending' };
    await this.#store.create(record);
    return record;
  }

  /**
   * A held interaction its runtime reported waiting again: it waits, whatever the runtime said of it
   * while an answer was with it (a resume that dropped the call, then failed and put it back). The
   * store indexes it if it didn't (one created before an index was built, say).
   */
  #reported(record: InteractionRecord): InteractionRecord {
    if (this.#answering.has(record.id)) this.#answering.set(record.id, undefined);
    // Whoever answered it in the session didn't: their answer didn't take.
    this.#attributions.delete(record.id);
    this.#store.adopt?.(record);
    return record;
  }

  /**
   * fork(claude-agent): say who answered a held interaction in its own session, as the answer goes to
   * the runtime outside the broker (its own in-session routes). The runtime's report that it settled
   * then names them. Returns a function that drops the attribution (the runtime refused the answer).
   */
  attribute(id: string, attribution: { resolvedBy?: string }): () => void {
    this.#attributions.set(id, attribution);
    return () => {
      if (this.#attributions.get(id) === attribution) this.#attributions.delete(id);
    };
  }

  /**
   * Settle a held interaction as its runtime reports it settled (answered in the session, or
   * abandoned). Publishes nothing: the runtime's own stream reports it. An interaction whose answer
   * is with the runtime right now is settled when that answer returns. Returns whether it settled.
   */
  async settleHeld(id: string, settlement: HeldSettlement): Promise<boolean> {
    const attribution = this.#attributions.get(id);
    const attributed =
      attribution?.resolvedBy && settlement.status === 'resolved' && !settlement.resolvedBy
        ? { ...settlement, resolvedBy: attribution.resolvedBy }
        : settlement;
    if (this.#answering.has(id)) {
      this.#answering.set(id, attributed);
      return false;
    }
    this.#attributions.delete(id);
    return (await this.#store.settle(id, this.#settlementOf(attributed))) !== undefined;
  }

  #settlementOf(settlement: HeldSettlement): Parameters<InteractionStore['settle']>[1] {
    const settledAt = this.#now().toISOString();
    return settlement.status === 'resolved'
      ? {
          status: 'resolved',
          response: settlement.response,
          ...(settlement.resolvedBy ? { resolvedBy: settlement.resolvedBy } : {}),
          settledAt,
        }
      : { status: 'cancelled', cancelReason: settlement.reason, settledAt };
  }

  /**
   * Hand the answer to the runtime that holds the interaction. Of two answers in this process, the
   * second is `not_pending` without reaching the runtime; the runtime decides between answers from
   * elsewhere. Its `not_pending` settles the record (it holds nothing for it any more).
   */
  async #resolveHeld(
    existing: InteractionRecord,
    response: InteractionResponse,
    options: { resolvedBy?: string; context?: unknown },
  ): Promise<ResolveOutcome> {
    const { id } = existing;
    if (!this.#answerHeld) throw new Error(`Nothing delivers answers to ${existing.heldBy} sessions`);
    if (this.#answering.has(id)) return { status: 'not_pending' };
    this.#answering.set(id, undefined);
    try {
      let result: CommandResult;
      try {
        result = await this.#answerHeld(existing, response, {
          ...(options.resolvedBy ? { resolvedBy: options.resolvedBy } : {}),
          ...(options.context !== undefined ? { context: options.context } : {}),
        });
      } catch (error) {
        // The runtime's own report of the interaction still stands, as for a refusal.
        const reported = this.#answering.get(id);
        if (reported) await this.#store.settle(id, this.#settlementOf(reported));
        throw error;
      }
      const reported = this.#answering.get(id);
      if (result.ok) {
        const record =
          (await this.#store.settle(
            id,
            this.#settlementOf({
              status: 'resolved',
              response,
              ...(options.resolvedBy ? { resolvedBy: options.resolvedBy } : {}),
            }),
          )) ?? (await this.#store.get(id));
        return { status: 'delivered', record: record ?? existing };
      }
      if (result.reason === 'not_pending') {
        await this.#store.settle(
          id,
          this.#settlementOf(reported ?? { status: 'cancelled', reason: HELD_INTERACTION_GONE }),
        );
        return { status: 'not_pending' };
      }
      // A runtime that still waits on it keeps it pending, whatever it reported meanwhile.
      if (reported && !result.waiting) await this.#store.settle(id, this.#settlementOf(reported));
      throw new InteractionAnswerRefusedError(id, result.reason, result.message);
    } finally {
      this.#answering.delete(id);
    }
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
