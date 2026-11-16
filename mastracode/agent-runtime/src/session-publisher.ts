import type { SessionEventHub } from './event-hub';
import type { EventEnvelope, FactoryEvent } from './events';

export interface SessionPublisherOptions {
  /** How long consecutive deltas may be held before they are flushed. Default 100 ms. */
  flushMs?: number;
  /** Called when persisting fails. Publishing never throws into the runtime. */
  onError?(error: unknown): void;
}

/**
 * A synchronous `emit` for runtime adapters that batches what would otherwise be thousands of tiny
 * events: consecutive `message.delta`s for the same message part, and consecutive `tool.output`
 * chunks for the same call and stream, are merged into one event. Anything else flushes the pending
 * batch first, so event order is preserved exactly.
 */
export class SessionPublisher {
  readonly #hub: SessionEventHub;
  readonly #sessionId: string;
  readonly #flushMs: number;
  readonly #onError: (error: unknown) => void;
  #pending: FactoryEvent | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #last: Promise<unknown> = Promise.resolve();

  constructor(hub: SessionEventHub, sessionId: string, options: SessionPublisherOptions = {}) {
    this.#hub = hub;
    this.#sessionId = sessionId;
    this.#flushMs = options.flushMs ?? 100;
    this.#onError = options.onError ?? (() => {});
  }

  emit = (event: FactoryEvent): void => {
    const merged = this.#pending && merge(this.#pending, event);
    if (merged) {
      this.#pending = merged;
      return;
    }
    this.#flushPending();
    if (isMergeable(event)) {
      this.#pending = event;
      this.#timer = setTimeout(() => this.#flushPending(), this.#flushMs);
      return;
    }
    this.#publish(event);
  };

  /** Publish anything pending and wait until everything emitted so far is stored. */
  async flush(): Promise<void> {
    this.#flushPending();
    await this.#last;
  }

  #flushPending(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) this.#publish(pending);
  }

  #publish(event: FactoryEvent): void {
    const stored: Promise<EventEnvelope[] | void> = this.#hub
      .publish(this.#sessionId, event)
      .catch(error => this.#onError(error));
    this.#last = stored;
  }
}

function isMergeable(event: FactoryEvent): boolean {
  return event.type === 'message.delta' || event.type === 'tool.output' || event.type === 'tool.input.delta';
}

function merge(pending: FactoryEvent, next: FactoryEvent): FactoryEvent | undefined {
  if (
    pending.type === 'message.delta' &&
    next.type === 'message.delta' &&
    pending.messageId === next.messageId &&
    pending.part === next.part
  ) {
    return { ...pending, delta: pending.delta + next.delta };
  }
  if (
    pending.type === 'tool.output' &&
    next.type === 'tool.output' &&
    pending.callId === next.callId &&
    pending.stream === next.stream
  ) {
    return { ...pending, chunk: pending.chunk + next.chunk };
  }
  if (pending.type === 'tool.input.delta' && next.type === 'tool.input.delta' && pending.callId === next.callId) {
    return { ...pending, delta: pending.delta + next.delta };
  }
  return undefined;
}
