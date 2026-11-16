// fork(claude-agent): a fast poll of the pull requests on cards in an active column, for a Factory
// GitHub cannot reach (no webhooks). Spec §6, "Pull requests on active cards without webhooks".
import { NoopLeaseProvider } from '@mastra/core/events';
import type { LeaseProvider } from '@mastra/core/events';
import { MastraWorker } from '@mastra/core/worker';
import type { WorkerDeps } from '@mastra/core/worker';

import { toBoardSource } from '../../boards/project-boards.js';
import { pullRequestSources, workItemPhaseSemantics } from '../../boards/semantics.js';
import type { Card } from '../../storage/domains/work-items/base.js';
import { getLeaseProvider, reconcileTargets } from './reconcile-worker.js';
import type { GithubReconcileRepositorySource } from './reconcile-worker.js';
import { GithubRules, attachedPullRequestNumber, reconcilablePullRequestNumber } from './rules.js';
import type { GithubRulesOptions, ReconcileRepository } from './rules.js';
import type { ParsedGithubWebhook } from './webhook.js';

/** How often the pull requests of active cards are polled by default. */
export const DEFAULT_ACTIVE_PULL_REQUEST_POLL_INTERVAL_MS = 60_000;

/**
 * Events from before this long ago are not replayed when a pull request is first polled by this
 * process (after a restart, its reviews and comments were most likely handled already; those that
 * were are skipped anyway, by their content key).
 */
const FIRST_POLL_LOOKBACK_MS = 15 * 60_000;

/** Pages of reviews or comments read for one pull request in one tick, at most. */
const MAX_PAGES = 10;

/**
 * One GitHub REST read, conditional on `etag` (`If-None-Match`): `304` when nothing changed, which
 * GitHub does not count against the rate limit. `link` is the answer's `Link` header (pagination).
 * Throws `GithubRateLimited` when GitHub says to wait.
 */
export type ConditionalGithubGet = (input: {
  installationId: number;
  path: string;
  etag?: string;
}) => Promise<{ status: 304 } | { status: 200; etag?: string; link?: string; data: unknown }>;

/** GitHub asked to wait (a `403`/`429` rate limit) until `resumeAt` (epoch ms). */
export class GithubRateLimited extends Error {
  readonly resumeAt: number;
  constructor(resumeAt: number) {
    super(`GitHub rate limit: resuming at ${new Date(resumeAt).toISOString()}`);
    this.name = 'GithubRateLimited';
    this.resumeAt = resumeAt;
  }
}

/**
 * When to resume after GitHub refused a read for its rate limit: `retry-after` (seconds), else
 * `x-ratelimit-reset` (epoch seconds) when none remain, else a minute for a `429`. `undefined` for an
 * answer that is not a rate limit.
 */
export function rateLimitResumeAt(
  status: unknown,
  headers: Record<string, unknown> | undefined,
  now = Date.now(),
): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const header = (name: string) => {
    const value = headers?.[name];
    const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const retryAfter = header('retry-after');
  if (retryAfter !== undefined) return now + retryAfter * 1_000;
  const reset = header('x-ratelimit-reset');
  if (header('x-ratelimit-remaining') === 0 && reset !== undefined) return reset * 1_000;
  return status === 429 ? now + 60_000 : undefined;
}

export interface ActivePullRequestPollSummary {
  /** Pull requests on active cards. */
  pullRequests: number;
  /** Reads GitHub answered with a body (each counts against the rate limit). */
  fetched: number;
  /** Reads GitHub answered `304 Not Modified` (free). */
  notModified: number;
  /** Events handed to the webhook path. */
  delivered: number;
  failed: number;
  errors: Array<{ repository: string; pullRequestNumber?: number; error: string }>;
  /** Set when GitHub's rate limit stopped the tick: no read before then. */
  rateLimitedUntil?: number;
}

export type GithubActivePullRequestPoll = (
  repositories: ReconcileRepository[],
) => Promise<ActivePullRequestPollSummary>;

/** What this process last saw of one pull request. */
interface Seen {
  /** The pull request as GitHub last sent it, which reviews and comments carry as a webhook's do. */
  pull?: { etag?: string; state: string; merged: boolean; headSha?: string; body: Record<string, unknown> };
  reviews?: { etag?: string };
  comments?: { etag?: string; since: number };
  /** Reviews and comments already handed on (or older than the first poll's window). */
  delivered: Set<string>;
  /** Only reviews and comments from then on are delivered. */
  since: number;
}

/**
 * Polls, every minute or so, the pull requests bound to cards in an active (working) column, with
 * conditional requests, and hands what changed to the webhook path (`deliver`: once per event, by
 * its content key, whether the webhook brought it too or not; the board's rules ingress, then the
 * sessions subscribed to the pull request): the pull request closed or merged, new commits on it, a
 * review submitted, a comment on it. The full reconcile sweeps still run.
 *
 * Each pull request costs three reads a tick (the pull request, its reviews, its comments), each
 * conditional on the ETag of the last answer, so an unchanged pull request costs nothing against
 * the rate limit. An answer's ETag and what it delivered are kept only once every delivery from it
 * succeeded, so a failed one is read and delivered again on the next tick. Reviews follow `Link`
 * pages; comments are read from the newest one seen on. When GitHub's rate limit refuses a read, the
 * tick stops and nothing is read before GitHub says to resume. State is per process: the first poll
 * of a pull request takes what it finds as known, delivering only a close or merge and reviews and
 * comments since its card entered its column (at most 15 minutes back).
 */
export function createActivePullRequestPoll(
  options: GithubRulesOptions,
  deps: {
    get: ConditionalGithubGet;
    deliver(event: ParsedGithubWebhook): Promise<void>;
    now?: () => number;
  },
): GithubActivePullRequestPoll {
  const rules = new GithubRules(options);
  const boards = toBoardSource(options.boards);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const seen = new Map<string, Seen>();
  let pausedUntil = 0;
  return async repositories => {
    const summary: ActivePullRequestPollSummary = {
      pullRequests: 0,
      fetched: 0,
      notModified: 0,
      delivered: 0,
      failed: 0,
      errors: [],
    };
    if (now() < pausedUntil) return { ...summary, rateLimitedUntil: pausedUntil };
    const fail = (repository: ReconcileRepository, error: unknown, pullRequestNumber?: number) => {
      summary.failed += 1;
      if (summary.errors.length < 5) {
        summary.errors.push({
          repository: repository.fullName,
          ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const kept = new Set<string>();
    /** Repositories whose cards could not be read: what was seen of them stays. */
    const unread = new Set<number>();
    try {
      for (const repository of repositories) {
        let active: Map<number, number>;
        try {
          active = await activePullRequests(options, rules, boards, repository);
        } catch (error) {
          unread.add(repository.id);
          fail(repository, error);
          continue;
        }
        for (const [number, enteredAt] of active) {
          const key = `${repository.id}:${number}`;
          kept.add(key);
          summary.pullRequests += 1;
          let entry = seen.get(key);
          if (!entry) {
            entry = { delivered: new Set(), since: Math.max(enteredAt, startedAt - FIRST_POLL_LOOKBACK_MS) };
            seen.set(key, entry);
          }
          try {
            await pollPullRequest(repository, number, entry, deps, summary);
          } catch (error) {
            if (error instanceof GithubRateLimited) throw error;
            fail(repository, error, number);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof GithubRateLimited)) throw error;
      pausedUntil = error.resumeAt;
      // Stopped part way: nothing seen is forgotten.
      return { ...summary, rateLimitedUntil: pausedUntil };
    }
    // A pull request no longer on an active card is forgotten; polled again, it starts over.
    for (const key of seen.keys()) {
      if (!kept.has(key) && !unread.has(Number(key.split(':')[0]))) seen.delete(key);
    }
    return summary;
  };
}

/** The pull requests of this repository on cards in a working column, with when each card entered it. */
async function activePullRequests(
  options: GithubRulesOptions,
  rules: GithubRules,
  boards: ReturnType<typeof toBoardSource>,
  repository: ReconcileRepository,
): Promise<Map<number, number>> {
  const projects =
    repository.projects ??
    (await options.sourceControl.projectRepositories.listByExternalRepository({
      installationExternalId: String(repository.installationId),
      repositoryExternalId: String(repository.id),
    }));
  const active = new Map<number, number>();
  for (const project of projects) {
    await rules.loadBoards(project);
    for (const item of await options.storage.listShared({
      orgId: project.orgId,
      factoryProjectId: project.factoryProjectId,
    })) {
      if (workItemPhaseSemantics(boards.forProject(item), item)?.kind !== 'working') continue;
      const enteredAt = enteredCurrentPhaseAt(item);
      for (const number of boundPullRequests(item, repository)) {
        active.set(number, Math.min(active.get(number) ?? enteredAt, enteredAt));
      }
    }
  }
  return active;
}

/** The pull requests a card is bound to in this repository: its own, or open ones attached to it. */
function boundPullRequests(item: Card, repository: ReconcileRepository): number[] {
  const own = reconcilablePullRequestNumber(item, repository);
  const attached = pullRequestSources(item)
    .filter(source => !['closed', 'merged'].includes(source.state ?? ''))
    .map(source => attachedPullRequestNumber(source, repository))
    .filter((number): number is number => number !== undefined);
  return [...new Set([...(own !== undefined ? [own] : []), ...attached])];
}

function enteredCurrentPhaseAt(item: Card): number {
  const stage = item.stages[0];
  const entry = [...(item.stageHistory ?? [])].reverse().find(history => history.stage === stage);
  const at = entry ? Date.parse(entry.enteredAt) : Number.NaN;
  return Number.isFinite(at) ? at : item.updatedAt.getTime();
}

/** The `rel="next"` page of a `Link` header, as a path on the API. */
function nextPage(link: string | undefined): string | undefined {
  const match = link?.split(',').find(part => /rel="next"/.test(part))?.match(/<([^>]+)>/);
  if (!match) return undefined;
  try {
    const url = new URL(match[1]!);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

async function pollPullRequest(
  repository: ReconcileRepository,
  number: number,
  entry: Seen,
  deps: Pick<Parameters<typeof createActivePullRequestPoll>[1], 'get' | 'deliver'>,
  summary: ActivePullRequestPollSummary,
): Promise<void> {
  const base = `/repos/${repository.fullName}`;
  const read = async (path: string, etag: string | undefined) => {
    const answer = await deps.get({ installationId: repository.installationId, path, ...(etag ? { etag } : {}) });
    if (answer.status === 304) summary.notModified += 1;
    else summary.fetched += 1;
    return answer;
  };
  /** Every page of a listing that changed: the first conditional, the rest only when it did. */
  const readAll = async (path: string, etag: string | undefined) => {
    const first = await read(path, etag);
    if (first.status === 304) return undefined;
    const items = list(first.data);
    let next = nextPage(first.link);
    for (let page = 1; next && page < MAX_PAGES; page++) {
      const more = await read(next, undefined);
      if (more.status === 304) break;
      items.push(...list(more.data));
      next = nextPage(more.link);
    }
    return { etag: first.etag, items };
  };
  const deliver = async (event: ParsedGithubWebhook) => {
    await deps.deliver(event);
    summary.delivered += 1;
  };
  const envelope = {
    installation: { id: repository.installationId },
    repository: { id: repository.id, full_name: repository.fullName },
  };

  // The pull request itself: closed or merged, and new commits. Kept once what it says was delivered.
  const pull = await read(`${base}/pulls/${number}`, entry.pull?.etag);
  if (pull.status === 200) {
    const pullRequest = record(pull.data);
    const state = pullRequest.state === 'closed' ? 'closed' : 'open';
    const merged = pullRequest.merged === true;
    const head = record(pullRequest.head);
    const headSha = typeof head.sha === 'string' ? head.sha : undefined;
    const before = entry.pull;
    if (state === 'closed' && before?.state !== 'closed') {
      const outcome = merged ? 'merged' : 'closed';
      await deliver({
        event: 'pull_request',
        // The reconcile sweep's id for the same outcome: whichever sees it first, the other replays it.
        deliveryId: `reconcile:${repository.id}:pull-request:${number}:${outcome}`,
        payload: {
          action: 'closed',
          ...envelope,
          sender: { login: login(pullRequest.merged_by) ?? 'github' },
          pull_request: pullRequest,
        },
      });
    } else if (state === 'open' && before?.headSha && headSha && headSha !== before.headSha) {
      await deliver({
        event: 'pull_request',
        deliveryId: `poll:${repository.id}:pull-request:${number}:synchronize:${headSha}`,
        payload: {
          action: 'synchronize',
          ...envelope,
          sender: { login: login(pullRequest.user) ?? 'github' },
          pull_request: pullRequest,
        },
      });
    }
    entry.pull = {
      ...(pull.etag ? { etag: pull.etag } : {}),
      state,
      merged,
      ...(headSha ? { headSha } : {}),
      body: pullRequest,
    };
  }
  // Reviews and comments name the pull request as GitHub's own payloads do.
  const prPayload = entry.pull?.body ?? {
    number,
    html_url: `https://github.com/${repository.fullName}/pull/${number}`,
  };

  const reviews = await readAll(`${base}/pulls/${number}/reviews?per_page=100`, entry.reviews?.etag);
  if (reviews) {
    for (const review of reviews.items) {
      const id = `review:${String(review.id)}`;
      if (review.state === 'PENDING' || entry.delivered.has(id)) continue;
      if (Date.parse(String(review.submitted_at)) >= entry.since) {
        await deliver({
          event: 'pull_request_review',
          deliveryId: `poll:${repository.id}:pull-request:${number}:${id}`,
          payload: {
            action: 'submitted',
            ...envelope,
            sender: senderOf(review.user),
            review,
            pull_request: prPayload,
          },
        });
      }
      entry.delivered.add(id);
    }
    entry.reviews = reviews.etag ? { etag: reviews.etag } : {};
  }

  // Comments since the newest one seen (GitHub's `since` reads `updated_at`), so the listing stays short.
  const since = entry.comments?.since ?? entry.since;
  const comments = await readAll(
    `${base}/issues/${number}/comments?per_page=100&since=${new Date(since).toISOString()}`,
    entry.comments?.etag,
  );
  if (comments) {
    let newest = since;
    for (const comment of comments.items) {
      const id = `comment:${String(comment.id)}`;
      const updatedAt = Date.parse(String(comment.updated_at ?? comment.created_at));
      if (Number.isFinite(updatedAt)) newest = Math.max(newest, updatedAt);
      if (entry.delivered.has(id)) continue;
      if (Date.parse(String(comment.created_at)) >= entry.since) {
        await deliver({
          event: 'issue_comment',
          deliveryId: `poll:${repository.id}:pull-request:${number}:${id}`,
          payload: {
            action: 'created',
            ...envelope,
            sender: senderOf(comment.user),
            comment,
            issue: {
              number,
              html_url: String(prPayload.html_url ?? ''),
              pull_request: { html_url: String(prPayload.html_url ?? '') },
            },
          },
        });
      }
      entry.delivered.add(id);
    }
    // Read from the newest on next time; a new `since` is a new listing, so its ETag starts over.
    entry.comments = newest > since ? { since: newest } : { since, ...(comments.etag ? { etag: comments.etag } : {}) };
  }
}

function senderOf(user: unknown): Record<string, unknown> {
  const type = userType(user);
  return { login: login(user) ?? 'github', ...(type ? { type } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function login(user: unknown): string | undefined {
  const value = record(user).login;
  return typeof value === 'string' ? value : undefined;
}

function userType(user: unknown): string | undefined {
  const value = record(user).type;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Runs the active pull request poll on its interval (`MASTRACODE_GITHUB_ACTIVE_PR_POLL_INTERVAL_MS`,
 * default a minute; `0` turns it off), under a lease of its own so replicas don't poll together. The
 * lease is kept (renewed each tick) rather than taken anew, so one process keeps the poll and its
 * ETags; with `preferred`, a process that isn't preferred (the one running Claude Agent sessions is)
 * leaves the lease to the preferred one for its first two intervals.
 */
export class GithubActivePullRequestPollWorker extends MastraWorker {
  readonly name = 'github-active-pull-request-poll';
  readonly #poll: GithubActivePullRequestPoll;
  readonly #sourceControl: GithubReconcileRepositorySource;
  readonly #intervalMs: number;
  readonly #preferred: (() => Promise<boolean>) | undefined;
  readonly #leaseOwner = globalThis.crypto.randomUUID();
  #leaseProvider: LeaseProvider = NoopLeaseProvider;
  #holding = false;
  #startedAt = 0;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(config: {
    poll: GithubActivePullRequestPoll;
    sourceControl: GithubReconcileRepositorySource;
    intervalMs?: number;
    preferred?: () => Promise<boolean>;
  }) {
    super();
    this.#poll = config.poll;
    this.#sourceControl = config.sourceControl;
    this.#preferred = config.preferred;
    this.#intervalMs = config.intervalMs ?? DEFAULT_ACTIVE_PULL_REQUEST_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new Error('GitHub active pull request poll interval must be a positive number.');
    }
  }

  async init(deps: WorkerDeps): Promise<void> {
    await super.init(deps);
    this.#leaseProvider = getLeaseProvider(deps.pubsub);
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = Date.now();
    this.#schedule(this.#intervalMs);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
    if (this.#holding) {
      this.#holding = false;
      await this.#leaseProvider.releaseLease(LEASE_KEY, this.#leaseOwner).catch(() => undefined);
    }
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** One poll now, under the lease (kept from the last tick, or taken). */
  async tick(): Promise<ActivePullRequestPollSummary | undefined> {
    if (!(await this.#lease())) return undefined;
    try {
      const summary = await this.#poll(await reconcileTargets(this.#sourceControl));
      if (summary.rateLimitedUntil !== undefined) {
        this.deps?.logger.warn('GitHub active pull request poll paused by the rate limit', summary);
      } else if (summary.failed > 0) {
        this.deps?.logger.warn('GitHub active pull request poll completed with failures', summary);
      } else if (summary.delivered > 0) {
        this.deps?.logger.info('GitHub active pull request poll delivered changes', summary);
      }
      return summary;
    } catch (error) {
      this.deps?.logger.warn('GitHub active pull request poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async #lease(): Promise<boolean> {
    const ttl = Math.max(30_000, this.#intervalMs * 3);
    if (this.#holding) {
      this.#holding = await this.#leaseProvider.renewLease(LEASE_KEY, this.#leaseOwner, ttl).catch(() => false);
      if (this.#holding) return true;
    }
    // Not the preferred process: leave the lease to it for a while after starting.
    if (this.#preferred && Date.now() - this.#startedAt < 2 * this.#intervalMs) {
      if (!(await this.#preferred().catch(() => false))) return false;
    }
    const lease = await this.#leaseProvider
      .acquireLease(LEASE_KEY, this.#leaseOwner, ttl)
      .catch(() => ({ acquired: false }));
    this.#holding = lease.acquired;
    return this.#holding;
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const run = this.tick()
        .then(() => undefined)
        .finally(() => {
          this.#inFlight = undefined;
          this.#schedule(this.#intervalMs);
        });
      this.#inFlight = run;
    }, delayMs);
    this.#timer.unref?.();
  }
}

const LEASE_KEY = 'github:active-pull-request-poll';

/** The poll's interval from the environment: unset is the default, `0` is off (`undefined`). */
export function activePullRequestPollInterval(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return DEFAULT_ACTIVE_PULL_REQUEST_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ACTIVE_PULL_REQUEST_POLL_INTERVAL_MS;
  return parsed === 0 ? undefined : Math.max(10_000, parsed);
}
