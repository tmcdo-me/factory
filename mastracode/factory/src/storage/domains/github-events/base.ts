// fork(claude-agent): GitHub events Factory already handled, by what they are (not by delivery), so the
// webhook and the active pull request poll never both act on one review, comment, push or close.
import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

const COLLECTION = 'factory_github_events_seen';

export const GITHUB_EVENTS_SEEN_SCHEMA: CollectionSchema = {
  name: COLLECTION,
  columns: {
    key: { type: 'text', primaryKey: true },
    status: { type: 'text' },
    claimed_at: { type: 'timestamp' },
  },
  indexes: [{ name: 'factory_github_events_seen_claimed_idx', columns: ['claimed_at'] }],
};

interface SeenRow extends Record<string, unknown> {
  key: string;
  status: 'claimed' | 'done';
  claimed_at: Date;
}

/** Handled events, and the ones being handled right now. */
export interface GithubEventClaims {
  /**
   * Take the event for handling: `false` when it was handled already, or is being handled (a claim
   * left by a process that died is taken over after `staleAfterMs`).
   */
  claim(key: string): Promise<boolean>;
  /** Handled: never handled again. */
  done(key: string): Promise<void>;
  /** Not handled after all (it failed): the next delivery of it handles it. */
  release(key: string): Promise<void>;
}

/** How long a claim may stand before another process takes the event over. */
const STALE_CLAIM_MS = 10 * 60_000;
/** How long a handled event is remembered. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;

export class GithubEventsSeenStorage extends FactoryStorageDomain implements GithubEventClaims {
  #prunedAt = 0;

  constructor() {
    super('github-events');
  }

  async init(): Promise<void> {
    await this.ensureCollections([GITHUB_EVENTS_SEEN_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(COLLECTION, {});
  }

  async claim(key: string): Promise<boolean> {
    const now = new Date();
    this.#prune(now);
    try {
      await this.ops.insertOne<SeenRow>(COLLECTION, { key, status: 'claimed', claimed_at: now });
      return true;
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
    // Taken over only from a claim nobody finished in time, and only by one caller.
    let taken = false;
    await this.ops.updateAtomic<SeenRow>(COLLECTION, { key }, current => {
      if (current.status !== 'claimed' || now.getTime() - new Date(current.claimed_at).getTime() < STALE_CLAIM_MS) {
        return null;
      }
      taken = true;
      return { claimed_at: now };
    });
    return taken;
  }

  async done(key: string): Promise<void> {
    await this.ops.updateMany(COLLECTION, { key }, { status: 'done' });
  }

  async release(key: string): Promise<void> {
    await this.ops.deleteMany(COLLECTION, { key, status: 'claimed' });
  }

  /** Now and then, forget what is past retention. Never holds up the claim that triggered it. */
  #prune(now: Date): void {
    if (now.getTime() - this.#prunedAt < 60 * 60_000) return;
    this.#prunedAt = now.getTime();
    const before = new Date(now.getTime() - RETENTION_MS);
    void (async () => {
      const old = await this.ops.findMany<SeenRow>(COLLECTION, {}, { orderBy: [['claimed_at', 'asc']], limit: 500 });
      for (const row of old) {
        if (new Date(row.claimed_at) >= before) break;
        await this.ops.deleteMany(COLLECTION, { key: row.key });
      }
    })().catch(() => undefined);
  }
}

/** In memory, for a server without the domain and for tests. */
export class InMemoryGithubEventClaims implements GithubEventClaims {
  readonly #rows = new Map<string, 'claimed' | 'done'>();
  async claim(key: string): Promise<boolean> {
    if (this.#rows.has(key)) return false;
    this.#rows.set(key, 'claimed');
    return true;
  }
  async done(key: string): Promise<void> {
    this.#rows.set(key, 'done');
  }
  async release(key: string): Promise<void> {
    if (this.#rows.get(key) === 'claimed') this.#rows.delete(key);
  }
}

/**
 * Claims that never stop an event: when the store can't be read, the event is handled (and may be
 * handled twice) rather than lost; that is said once in the log.
 */
export function failOpenGithubEventClaims(store: () => Promise<GithubEventClaims>): GithubEventClaims {
  let warned = false;
  const warn = (error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn('[factory] GitHub events handled could not be recorded; an event may be handled twice.', error);
  };
  return {
    claim: async key => {
      try {
        return await (await store()).claim(key);
      } catch (error) {
        warn(error);
        return true;
      }
    },
    done: async key => {
      try {
        await (await store()).done(key);
      } catch (error) {
        warn(error);
      }
    },
    release: async key => {
      try {
        await (await store()).release(key);
      } catch (error) {
        warn(error);
      }
    },
  };
}
