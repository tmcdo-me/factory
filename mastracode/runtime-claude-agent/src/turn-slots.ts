import type { ClaudeTurnSlot, ClaudeTurnSlots } from './session';

/** Who a turn is for: a person at the keyboard goes ahead of Factory's own runs. */
export type ClaudeTurnPriority = 'person' | 'factory';

export interface ClaudeTurnLimiterOptions {
  /** How many sessions may run a turn at once; `undefined` or `0` is no limit. Read on every change. */
  cap(): number | undefined;
  /** Told whenever a session starts or stops waiting for a slot. */
  onChanged?(sessionId: string): void;
}

/** A session waiting for a slot. */
export interface ClaudeTurnWaiter {
  sessionId: string;
  /** 1 for the next to go. */
  position: number;
  priority: ClaudeTurnPriority;
  since: Date;
}

interface Holder {
  /** Waiting on a person (a question, a plan): Claude Code is idle until they answer, so it isn't counted. */
  parked: boolean;
}

interface Waiter {
  sessionId: string;
  priority: ClaudeTurnPriority;
  since: Date;
  admit(): void;
}

/**
 * Caps how many Claude Agent sessions run a turn at once, across one process (the one process that
 * runs Claude Agent sessions). A session holds a slot from its first open turn until its last one
 * ends, so what is counted is exactly the Claude Code turns in flight: background work left running
 * between turns isn't, and a turn parked on a person isn't either while they decide (when they
 * answer it goes on at once, even past the cap; the next turn to start then waits). Over the cap a
 * turn waits for a slot, people's turns first, otherwise in the order they came; nothing is refused.
 * A change of the cap applies at once (`update`).
 */
export class ClaudeTurnLimiter {
  readonly #options: ClaudeTurnLimiterOptions;
  readonly #holders = new Map<string, Holder>();
  readonly #waiting: Waiter[] = [];

  constructor(options: ClaudeTurnLimiterOptions) {
    this.#options = options;
  }

  /** The slots of one session's turns; `priority` is asked for each turn as it is sent. */
  slots(sessionId: string, priority: (runId: string) => ClaudeTurnPriority = () => 'factory'): ClaudeTurnSlots {
    return { take: ({ runId }) => this.#take(sessionId, priority(runId)) };
  }

  /** The cap in force: `undefined` when there is none. */
  cap(): number | undefined {
    const cap = this.#options.cap();
    return cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined;
  }

  /** Sessions running a turn now (parked ones excluded), and those waiting, next first. */
  snapshot(): { cap: number | undefined; running: number; waiting: ClaudeTurnWaiter[] } {
    return {
      cap: this.cap(),
      running: this.#running(),
      waiting: this.#waiting.map((waiter, index) => ({
        sessionId: waiter.sessionId,
        position: index + 1,
        priority: waiter.priority,
        since: waiter.since,
      })),
    };
  }

  /** The session's turn now waits on a person: its slot is free for another meanwhile. */
  park(sessionId: string): void {
    const holder = this.#holders.get(sessionId);
    if (!holder || holder.parked) return;
    holder.parked = true;
    this.#admitWaiting();
  }

  /** The person answered: the turn goes on, counted again. */
  unpark(sessionId: string): void {
    const holder = this.#holders.get(sessionId);
    if (holder) holder.parked = false;
  }

  /** Re-read the cap and let in whoever now fits. */
  update(): void {
    this.#admitWaiting();
  }

  #running(): number {
    let running = 0;
    for (const holder of this.#holders.values()) if (!holder.parked) running += 1;
    return running;
  }

  #fits(): boolean {
    const cap = this.cap();
    return cap === undefined || this.#running() < cap;
  }

  #take(sessionId: string, priority: ClaudeTurnPriority): ClaudeTurnSlot {
    let released = false;
    let holder: Holder | undefined;
    const hold = () => {
      holder = { parked: false };
      this.#holders.set(sessionId, holder);
    };
    const release = () => {
      if (released) return;
      released = true;
      const index = this.#waiting.indexOf(waiter);
      if (index >= 0) {
        this.#waiting.splice(index, 1);
        this.#changed(sessionId);
      }
      if (holder && this.#holders.get(sessionId) === holder) this.#holders.delete(sessionId);
      this.#admitWaiting();
    };
    let admit!: () => void;
    const ready = new Promise<void>(resolve => {
      admit = resolve;
    });
    const waiter: Waiter = {
      sessionId,
      priority,
      since: new Date(),
      admit: () => {
        hold();
        admit();
      },
    };
    if (this.#waiting.length === 0 && this.#fits()) {
      hold();
      admit();
      return { ready, release };
    }
    // People go ahead of Factory's runs, but never ahead of another person.
    const at = priority === 'person' ? this.#waiting.findIndex(other => other.priority !== 'person') : -1;
    if (at >= 0) this.#waiting.splice(at, 0, waiter);
    else this.#waiting.push(waiter);
    this.#changed(sessionId);
    const position = this.#waiting.indexOf(waiter) + 1;
    const cap = this.cap() ?? 0;
    const ahead = position === 1 ? '' : ` ${position - 1} ${position === 2 ? 'turn waits' : 'turns wait'} ahead of it.`;
    return {
      ready,
      release,
      waiting: `Waiting for a Claude Agent slot: ${this.#running()} of ${cap} running, the most this server runs at once.${ahead} This turn starts as soon as one ends.`,
    };
  }

  #admitWaiting(): void {
    while (this.#waiting.length && this.#fits()) {
      const next = this.#waiting.shift()!;
      next.admit();
      this.#changed(next.sessionId);
    }
  }

  #changed(sessionId: string): void {
    try {
      this.#options.onChanged?.(sessionId);
    } catch (error) {
      console.warn('[factory] A Claude Agent slot listener failed.', error);
    }
  }
}
