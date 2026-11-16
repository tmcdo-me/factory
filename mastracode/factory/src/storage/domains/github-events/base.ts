// fork(claude-agent): GitHub events Factory already handled, by what they are (not by delivery), so the
// webhook and the active pull request poll never both act on one review, comment, push or close.
import { randomUUID } from 'node:crypto';

import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

const COLLECTION = 'factory_github_events_seen';

export const GITHUB_EVENTS_SEEN_SCHEMA: CollectionSchema = {
  name: COLLECTION,
  columns: {
    key: { type: 'text', primaryKey: true },
    status: { type: 'text' },
    owner: { type: 'text', nullable: true },
    claimed_at: { type: 'timestamp' },
  },
  indexes: [{ name: 'factory_github_events_seen_claimed_idx', columns: ['claimed_at'] }],
};

interface SeenRow extends Record<string, unknown> {
  key: string;
  status: 'claimed' | 'done';
  owner: string | null;
  claimed_at: Date;
}

/**
 * What a claim found: the event is this caller's to handle (`taken`, with the token that finishes
 * it), it was handled already (`done`), or another caller is handling it right now (`busy`: try
 * again later, it may yet give it back).
 */
export type GithubEventClaim = { state: 'taken'; token: string } | { state: 'done' } | { state: 'busy' };

/** Handled events, and the ones being handled right now. */
export interface GithubEventClaims {
  /** Take the event for handling (a claim left by a process that died is taken over after `staleAfterMs`). */
  claim(key: string): Promise<GithubEventClaim>;
  /** Handled: never handled again. Only the claim `token` names. */
  done(key: string, token: string): Promise<void>;
  /** Not handled after all (it failed): the next delivery of it handles it. Only the claim `token` names. */
  release(key: string, token: string): Promise<void>;
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

  async claim(key: string): Promise<GithubEventClaim> {
    const now = new Date();
    const token = randomUUID();
    this.#prune(now);
    try {
      await this.ops.insertOne<SeenRow>(COLLECTION, { key, status: 'claimed', owner: token, claimed_at: now });
      return { state: 'taken', token };
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
    // Taken over only from a claim nobody finished in time, and only by one caller.
    let found: GithubEventClaim = { state: 'busy' };
    await this.ops.updateAtomic<SeenRow>(COLLECTION, { key }, current => {
      if (current.status === 'done') {
        found = { state: 'done' };
        return null;
      }
      if (now.getTime() - new Date(current.claimed_at).getTime() < STALE_CLAIM_MS) return null;
      found = { state: 'taken', token };
      return { owner: token, claimed_at: now };
    });
    return found;
  }

  async done(key: string, token: string): Promise<void> {
    await this.ops.updateMany(COLLECTION, { key, owner: token }, { status: 'done' });
  }

  async release(key: string, token: string): Promise<void> {
    await this.ops.deleteMany(COLLECTION, { key, status: 'claimed', owner: token });
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
  readonly #rows = new Map<string, { status: 'claimed' | 'done'; token: string }>();
  async claim(key: string): Promise<GithubEventClaim> {
    const row = this.#rows.get(key);
    if (row) return { state: row.status === 'done' ? 'done' : 'busy' };
    const token = randomUUID();
    this.#rows.set(key, { status: 'claimed', token });
    return { state: 'taken', token };
  }
  async done(key: string, token: string): Promise<void> {
    if (this.#rows.get(key)?.token === token) this.#rows.set(key, { status: 'done', token });
  }
  async release(key: string, token: string): Promise<void> {
    const row = this.#rows.get(key);
    if (row?.status === 'claimed' && row.token === token) this.#rows.delete(key);
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
        return { state: 'taken', token: 'unrecorded' };
      }
    },
    done: async (key, token) => {
      try {
        await (await store()).done(key, token);
      } catch (error) {
        warn(error);
      }
    },
    release: async (key, token) => {
      try {
        await (await store()).release(key, token);
      } catch (error) {
        warn(error);
      }
    },
  };
}
