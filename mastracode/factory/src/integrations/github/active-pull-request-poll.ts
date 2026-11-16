// fork(claude-agent): a fast poll of the pull requests on cards in an active column, for a Factory
// GitHub cannot reach (no webhooks). Spec §6, "Pull requests on active cards without webhooks".
import { createHash } from 'node:crypto';

import { NoopLeaseProvider } from '@mastra/core/events';
import type { LeaseProvider } from '@mastra/core/events';
import { MastraWorker } from '@mastra/core/worker';
import type { WorkerDeps } from '@mastra/core/worker';

import { toBoardSource } from '../../boards/project-boards.js';
import { pullRequestSources, workItemPhaseSemantics } from '../../boards/semantics.js';
import type { Card } from '../../storage/domains/work-items/base.js';
import { PULL_REQUEST_CI_METADATA_KEY, failureSignature, latestReviewStates, pullRequestCiStatus } from './pull-request-ci.js';
import type { PullRequestCiMetadata } from './pull-request-ci.js';
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

/**
 * Another caller (the webhook) is handling this event right now. The answer it came from is read
 * again next tick (neither its ETag nor the event is kept), in case that caller fails.
 */
export class GithubEventBusy extends Error {
  constructor(deliveryId: string) {
    super(`GitHub event ${deliveryId} is being handled elsewhere; read again next tick.`);
    this.name = 'GithubEventBusy';
  }
}

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
  /** fork(claude-agent): each reviewer's latest standing review, from the last full listing. */
  reviewStates?: Record<string, string>;
  /** The head's check runs and commit statuses, as last read (per head: a push starts over). */
  checks?: { sha: string; runsEtag?: string; statusEtag?: string; runs: Record<string, unknown>[]; statuses: Record<string, unknown>[] };
  /** Failures already sent back to the card's run, by `<head> <signature>`. */
  sentFailures?: Set<string>;
}

/** fork(claude-agent): how the poll follows a pull request's CI for its cards (Settings → Manage Factory). */
export interface ActivePollCiFollow {
  mode(project: { orgId: string; factoryProjectId: string }): Promise<'off' | 'status' | 'autofix'>;
  /** Factory's own app: its check runs (review checks) aren't the repository's CI. */
  ownApp?: string;
}

/** An active pull request: when its first card entered its column, its cards, and how its CI is followed. */
interface ActivePullRequest {
  enteredAt: number;
  cards: Card[];
  mode: 'off' | 'status' | 'autofix';
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
    /** fork(claude-agent): follow the head's CI for the card (status, and failures sent back to Build). */
    ci?: ActivePollCiFollow;
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
        let active: Map<number, ActivePullRequest>;
        try {
          active = await activePullRequests(options, rules, boards, repository, deps.ci);
        } catch (error) {
          unread.add(repository.id);
          fail(repository, error);
          continue;
        }
        for (const [number, { enteredAt, cards, mode }] of active) {
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
            if (mode !== 'off') await followCi(options, repository, number, entry, cards, mode, deps, summary);
          } catch (error) {
            if (error instanceof GithubRateLimited) throw error;
            // The webhook has it in hand: this pull request is read again next tick.
            if (error instanceof GithubEventBusy) continue;
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
  ci: ActivePollCiFollow | undefined,
): Promise<Map<number, ActivePullRequest>> {
  const projects =
    repository.projects ??
    (await options.sourceControl.projectRepositories.listByExternalRepository({
      installationExternalId: String(repository.installationId),
      repositoryExternalId: String(repository.id),
    }));
  const active = new Map<number, ActivePullRequest>();
  const rank = { off: 0, status: 1, autofix: 2 } as const;
  for (const project of projects) {
    await rules.loadBoards(project);
    const mode = ci ? await ci.mode(project) : 'off';
    for (const item of await options.storage.listShared({
      orgId: project.orgId,
      factoryProjectId: project.factoryProjectId,
    })) {
      if (workItemPhaseSemantics(boards.forProject(item), item)?.kind !== 'working') continue;
      const enteredAt = enteredCurrentPhaseAt(item);
      for (const number of boundPullRequests(item, repository)) {
        const known = active.get(number);
        active.set(number, {
          enteredAt: Math.min(known?.enteredAt ?? enteredAt, enteredAt),
          cards: [...(known?.cards ?? []), item],
          mode: known && rank[known.mode] > rank[mode] ? known.mode : mode,
        });
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
    let pages = 1;
    for (; next && pages < MAX_PAGES; pages++) {
      const more = await read(next, undefined);
      if (more.status === 304) break;
      items.push(...list(more.data));
      next = nextPage(more.link);
    }
    // A later page can change while the first stays the same: a list of several pages is read whole.
    return { ...(pages === 1 && first.etag ? { etag: first.etag } : {}), items };
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
        // A merge has the reconcile sweep's id, so whichever sees it first, the other replays it; a pull
        // request can be closed again after a reopen, so each close is its own.
        deliveryId: `reconcile:${repository.id}:pull-request:${number}:${outcome}${
          outcome === 'closed' && typeof pullRequest.closed_at === 'string' ? `:${pullRequest.closed_at}` : ''
        }`,
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
          before: before.headSha,
          after: headSha,
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
    entry.reviewStates = latestReviewStates(reviews.items);
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

/**
 * fork(claude-agent): the head's CI for the pull request's cards. Its check runs and commit statuses are
 * read conditionally, as the rest; the status (with the reviews' standing) is written on each card
 * when it changed; with auto-fix, a failure not yet sent back for this head goes to the board's rules
 * as `pullRequestChecksFailed`, once. Only a same-repository head's checks count: a fork's CI is
 * not the repository's own.
 */
async function followCi(
  options: GithubRulesOptions,
  repository: ReconcileRepository,
  number: number,
  entry: Seen,
  cards: Card[],
  mode: 'status' | 'autofix',
  deps: Pick<Parameters<typeof createActivePullRequestPoll>[1], 'get' | 'deliver' | 'ci'>,
  summary: ActivePullRequestPollSummary,
): Promise<void> {
  const pull = entry.pull;
  const head = record(pull?.body.head);
  const sha = typeof head.sha === 'string' ? head.sha.toLowerCase() : undefined;
  if (!pull || !sha) return;
  const sameRepository = record(head.repo).id === repository.id;
  const read = async (path: string, etag: string | undefined) => {
    const answer = await deps.get({ installationId: repository.installationId, path, ...(etag ? { etag } : {}) });
    if (answer.status === 304) summary.notModified += 1;
    else summary.fetched += 1;
    return answer;
  };
  if (pull.state === 'open' && sameRepository) {
    const known = entry.checks?.sha === sha ? entry.checks : undefined;
    const base = `/repos/${repository.fullName}/commits/${sha}`;
    const runs = await read(`${base}/check-runs?per_page=100`, known?.runsEtag);
    const statuses = await read(`${base}/status`, known?.statusEtag);
    entry.checks = {
      sha,
      ...(runs.status === 200 ? (runs.etag ? { runsEtag: runs.etag } : {}) : known?.runsEtag ? { runsEtag: known.runsEtag } : {}),
      ...(statuses.status === 200
        ? statuses.etag
          ? { statusEtag: statuses.etag }
          : {}
        : known?.statusEtag
          ? { statusEtag: known.statusEtag }
          : {}),
      runs: runs.status === 200 ? list(record(runs.data).check_runs) : (known?.runs ?? []),
      statuses: statuses.status === 200 ? list(record(statuses.data).statuses) : (known?.statuses ?? []),
    };
  }
  const computed = pullRequestCiStatus({
    open: pull.state === 'open' && sameRepository,
    checkRuns: entry.checks?.sha === sha ? entry.checks.runs : [],
    statuses: entry.checks?.sha === sha ? entry.checks.statuses : [],
    reviewStates: entry.reviewStates ?? {},
    ...(deps.ci?.ownApp ? { ownApp: deps.ci.ownApp } : {}),
  });
  const metadata: PullRequestCiMetadata | null = computed
    ? {
        status: computed.status,
        pullRequestNumber: number,
        headSha: sha,
        failing: computed.failing.map(({ excerpt: _excerpt, ...check }) => check),
        updatedAt: new Date().toISOString(),
      }
    : null;
  for (const card of cards) {
    const current = card.metadata?.[PULL_REQUEST_CI_METADATA_KEY] as PullRequestCiMetadata | undefined;
    const same =
      (current ?? null) === null
        ? metadata === null
        : metadata !== null &&
          current!.status === metadata.status &&
          current!.headSha === metadata.headSha &&
          current!.pullRequestNumber === metadata.pullRequestNumber &&
          JSON.stringify(current!.failing) === JSON.stringify(metadata.failing);
    if (same) continue;
    await options.storage.syncCard({
      orgId: card.orgId,
      id: card.id,
      userId: 'factory-ci',
      patch: { metadata: { [PULL_REQUEST_CI_METADATA_KEY]: metadata } },
    });
  }
  if (mode !== 'autofix' || computed?.status !== 'checks_failing') return;
  const signature = failureSignature(computed.failing);
  const sent = (entry.sentFailures ??= new Set());
  const key = `${sha} ${signature}`;
  if (sent.has(key)) return;
  await deps.deliver({
    event: 'check_suite',
    deliveryId: `ci:${repository.id}:pull-request:${number}:${sha}:${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`,
    payload: {
      action: 'completed',
      installation: { id: repository.installationId },
      repository: { id: repository.id, full_name: repository.fullName },
      sender: { login: 'github' },
      check_suite: { head_sha: sha, conclusion: 'failure' },
      pull_request: pull.body,
      factory_checks: { headSha: sha, signature, failing: computed.failing },
    },
  });
  sent.add(key);
  summary.delivered += 1;
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

  /** fork(claude-agent): poll again in a few seconds (a check webhook said something changed). */
  nudge(): void {
    if (!this.#running || this.#inFlight) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#schedule(NUDGE_DELAY_MS);
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

/** How soon a check webhook's nudge polls: a burst of check events is one poll. */
const NUDGE_DELAY_MS = 5_000;

/** The poll's interval from the environment: unset is the default, `0` is off (`undefined`). */
export function activePullRequestPollInterval(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return DEFAULT_ACTIVE_PULL_REQUEST_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ACTIVE_PULL_REQUEST_POLL_INTERVAL_MS;
  return parsed === 0 ? undefined : Math.max(10_000, parsed);
}
