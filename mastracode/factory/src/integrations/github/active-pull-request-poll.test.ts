// fork(claude-agent): the pull requests of cards in an active column, polled with conditional requests
// for a Factory GitHub can't reach (no webhooks).
import { createHash } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTriageWorkRegistry } from '../../boards/test-utils.js';
import { GithubEventsSeenStorage } from '../../storage/domains/github-events/base.js';
import { createFactoryStorageForTests } from '../../storage/test-utils.js';
import {
  GithubActivePullRequestPollWorker,
  GithubEventBusy,
  GithubRateLimited,
  createActivePullRequestPoll,
  rateLimitResumeAt,
} from './active-pull-request-poll.js';
import type { ConditionalGithubGet } from './active-pull-request-poll.js';
import { resolveGithubRules } from './default-rules.js';
import type { GithubIntegration } from './integration.js';
import { GithubRules, createGithubPullRequestReconciler } from './rules.js';
import type { GithubRulesOptions } from './rules.js';
import { githubEventContentKey, processGithubEvent } from './webhook.js';
import type { ParsedGithubWebhook } from './webhook.js';

const repository = { id: 10, fullName: 'acme/repo', installationId: 7 };

/**
 * GitHub's REST API as the poll reads it: each resource answers with an ETag of its content, and a
 * read naming that ETag gets `304 Not Modified`, as GitHub's conditional requests do.
 */
function fakeGithub(now: () => number) {
  const pull: Record<string, unknown> = {
    number: 17,
    html_url: 'https://github.com/acme/repo/pull/17',
    title: 'PR 17',
    state: 'open',
    merged: false,
    draft: false,
    user: { login: 'pr-author' },
    head: { ref: 'feature', sha: 'a'.repeat(40), repo: { id: 10 } },
    base: { ref: 'main', repo: { id: 10 } },
    labels: [],
    assignees: [],
    requested_reviewers: [],
  };
  const reviews: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  const reads: Array<{ path: string; status: number }> = [];
  const limits = { pageSize: 100, rateLimitedUntil: 0 };
  const resource = (path: string): unknown => {
    if (path === '/repos/acme/repo/pulls/17') return pull;
    if (path.startsWith('/repos/acme/repo/pulls/17/reviews?per_page=100')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      return reviews.slice((page - 1) * limits.pageSize, page * limits.pageSize);
    }
    if (path.startsWith('/repos/acme/repo/issues/17/comments?per_page=100&since=')) {
      const since = Date.parse(decodeURIComponent(path.split('since=')[1]!));
      return comments.filter(comment => Date.parse(String(comment.created_at)) >= since);
    }
    throw Object.assign(new Error(`Not Found: ${path}`), { status: 404 });
  };
  const get: ConditionalGithubGet = async ({ path, etag }) => {
    if (now() < limits.rateLimitedUntil) throw new GithubRateLimited(limits.rateLimitedUntil);
    const body = resource(path);
    const current = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    if (etag === current) {
      reads.push({ path, status: 304 });
      return { status: 304 };
    }
    reads.push({ path, status: 200 });
    // Reviews come a page at a time, the next one named in `Link`, as GitHub's do.
    let link: string | undefined;
    if (path.startsWith('/repos/acme/repo/pulls/17/reviews')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      if (reviews.length > page * limits.pageSize) {
        link = `<https://api.github.com/repos/acme/repo/pulls/17/reviews?per_page=100&page=${page + 1}>; rel="next"`;
      }
    }
    return { status: 200, etag: current, ...(link ? { link } : {}), data: structuredClone(body) };
  };
  return {
    get,
    reads,
    limits,
    pull,
    review: (id: number, state: string, submittedAt = new Date(now()).toISOString()) =>
      reviews.push({ id, state, body: 'Please fix the tests.', submitted_at: submittedAt, user: { login: 'reviewer' } }),
    comment: (id: number, createdAt = new Date(now()).toISOString()) =>
      comments.push({
        id,
        body: 'Looks close.',
        created_at: createdAt,
        updated_at: createdAt,
        user: { login: 'reviewer' },
      }),
  };
}

/** The events Factory handled, kept in storage, as a server keeps them. */
async function eventClaims() {
  const storage = new LibSQLFactoryStorage({ id: 'github-events-test', url: ':memory:' });
  const claims = storage.registerDomain(new GithubEventsSeenStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return claims;
}

async function setup(stages: string[] = ['review'], enteredAt = '2030-01-01T00:00:00Z') {
  const seeded = await createFactoryStorageForTests();
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Acme' } });
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: '7',
  });
  const linked = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '10', slug: 'acme/repo', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: linked.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  const card = (
    await seeded.workItems.upsert({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: project.id,
      input: {
        externalSource: {
          integrationId: 'github',
          type: 'pull-request',
          externalId: 'github-pr:17',
          url: 'https://github.com/acme/repo/pull/17',
        },
        title: 'PR 17',
        stages,
        sessions: {},
        metadata: { author: 'pr-author', state: 'open', merged: false },
      },
    })
  ).item;
  // When the card entered its column.
  await seeded.workItems.update({
    orgId: 'org-1',
    id: card.id,
    userId: 'user-1',
    patch: { stageHistory: [{ stage: stages[0]!, enteredAt, by: 'user-1' }] },
  });
  const options: GithubRulesOptions = {
    github: {
      rules: resolveGithubRules(),
      slug: 'factory-app',
      getRepositoryCollaboratorPermission: vi.fn().mockResolvedValue('write'),
    } as unknown as GithubIntegration,
    sourceControl,
    integrationStorage: seeded.integrations.forIntegration('github') as never,
    projects: seeded.projects,
    storage: seeded.workItems,
    configVersion: 'factory-config-v1',
    boards: createTriageWorkRegistry(),
  };
  // The webhook path: the board's rules ingress (then, in the server, the subscribed sessions).
  const rules = new GithubRules(options);
  const claims = await eventClaims();
  // What reached the subscribed sessions; `failing` makes the next deliveries fail, as a session can.
  const delivered: ParsedGithubWebhook[] = [];
  const failing = { next: 0 };
  // As the server handles an event: once per event, whether the webhook or the poll brought it.
  const handle = (event: ParsedGithubWebhook) =>
    processGithubEvent(event, {
      claims,
      ingest: parsed => rules.ingest(parsed),
      dispatch: async parsed => {
        if (failing.next > 0) {
          failing.next -= 1;
          return { failed: 1 };
        }
        delivered.push(parsed);
        return { failed: 0 };
      },
    });
  // As the server's poll delivers: an event the webhook is handling is read again next tick.
  const deliver = async (event: ParsedGithubWebhook) => {
    if ((await handle(event)) === 'busy') throw new GithubEventBusy(event.deliveryId);
  };
  const decisions = () => seeded.workItems.listDeferredDecisions('org-1', project.id);
  return { options, deliver, handle, delivered, failing, decisions, card, workItems: seeded.workItems, claims };
}

describe('the active pull request poll', () => {
  it('delivers a review and a merge on a card in review within a tick, and costs nothing while nothing changed', async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });

    // First look: what is there is known; nothing to deliver.
    expect(await poll([repository])).toMatchObject({ pullRequests: 1, fetched: 3, notModified: 0, delivered: 0 });
    // Nothing changed: every read is a 304, which GitHub doesn't count against the rate limit.
    clock += 60_000;
    expect(await poll([repository])).toMatchObject({ fetched: 0, notModified: 3, delivered: 0 });

    // A reviewer asks for changes and comments.
    clock += 30_000;
    github.review(900, 'CHANGES_REQUESTED');
    github.comment(500);
    clock += 30_000;
    expect(await poll([repository])).toMatchObject({ fetched: 2, notModified: 1, delivered: 2 });
    expect(context.delivered.map(event => [event.event, event.payload.action, event.deliveryId])).toEqual([
      ['pull_request_review', 'submitted', 'poll:10:pull-request:17:review:900'],
      ['issue_comment', 'created', 'poll:10:pull-request:17:comment:500'],
    ]);
    expect(context.delivered[0]!.payload).toMatchObject({
      repository: { id: 10, full_name: 'acme/repo' },
      installation: { id: 7 },
      sender: { login: 'reviewer' },
      review: { id: 900, state: 'CHANGES_REQUESTED' },
      pull_request: { number: 17, head: { ref: 'feature' } },
    });
    expect(context.delivered[1]!.payload).toMatchObject({ issue: { number: 17, pull_request: expect.any(Object) } });
    // Read again: each is delivered once. Comments are read from the newest one on now (one read).
    clock += 60_000;
    expect(await poll([repository])).toMatchObject({ delivered: 0, notModified: 2, fetched: 1 });
    clock += 60_000;
    expect(await poll([repository])).toMatchObject({ delivered: 0, notModified: 3 });

    // Merged: the board's merge rule runs, as for the webhook.
    Object.assign(github.pull, { state: 'closed', merged: true, merged_by: { login: 'maintainer' } });
    clock += 60_000;
    expect(await poll([repository])).toMatchObject({ delivered: 1 });
    expect(context.delivered.at(-1)).toMatchObject({
      event: 'pull_request',
      deliveryId: 'reconcile:10:pull-request:17:merged',
      payload: { action: 'closed', pull_request: { merged: true } },
    });
    const done = (await context.decisions()).filter(({ decision }) => decision.type === 'transition');
    expect(done).toEqual([
      expect.objectContaining({
        workItemId: context.card.id,
        decision: expect.objectContaining({ type: 'transition', stage: 'done' }),
      }),
    ]);

    // The slow sweep replays the same merge: the ingress absorbs it.
    const reconcile = createGithubPullRequestReconciler(context.options, async () => ({
      title: 'PR 17',
      url: 'https://github.com/acme/repo/pull/17',
      state: 'closed',
      draft: false,
      merged: true,
      headBranch: 'feature',
      baseBranch: 'main',
      mergedBy: 'maintainer',
    }));
    await reconcile([repository]);
    expect((await context.decisions()).filter(({ decision }) => decision.type === 'transition')).toHaveLength(1);
  });

  it("leaves alone a card's pull request while the card rests outside an active column", async () => {
    const github = fakeGithub(Date.now);
    const context = await setup(['done']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver });

    expect(await poll([repository])).toMatchObject({ pullRequests: 0, fetched: 0, notModified: 0 });
    expect(github.reads).toEqual([]);
  });

  it('after a restart, replays only what came since the card entered its column, at most 15 minutes back', async () => {
    const clock = Date.parse('2030-01-01T05:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review'], '2030-01-01T02:00:00Z');
    github.review(1, 'COMMENTED', '2030-01-01T03:00:00Z'); // long before this process started
    github.review(2, 'CHANGES_REQUESTED', '2030-01-01T04:55:00Z'); // while it restarted
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });

    await poll([repository]);
    expect(context.delivered.map(event => event.deliveryId)).toEqual(['poll:10:pull-request:17:review:2']);
  });

  it('hands on a review the webhook already brought only once, and after a restart not again', async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    await poll([repository]);

    // The review arrives by webhook first (GitHub's own delivery id), then the poll sees it too.
    clock += 30_000;
    github.review(900, 'CHANGES_REQUESTED');
    const [review] = (await github.get({ installationId: 7, path: '/repos/acme/repo/pulls/17/reviews?per_page=100' }))
      .data as Record<string, unknown>[];
    expect(
      await context.handle({
        event: 'pull_request_review',
        deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        payload: {
          action: 'submitted',
          installation: { id: 7 },
          repository: { id: 10, full_name: 'acme/repo' },
          sender: { login: 'reviewer' },
          review,
          pull_request: github.pull,
        },
      }),
    ).toBe('handled');
    clock += 30_000;
    expect(await poll([repository])).toMatchObject({ delivered: 1 });
    expect(context.delivered.map(event => event.deliveryId)).toEqual(['72d3162e-cc78-11e3-81ab-4c9367dc0958']);

    // A restart forgets the poll's own state, not what was handled.
    const restarted = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    await restarted([repository]);
    expect(context.delivered).toHaveLength(1);
  });

  it('reads an answer again when one of its deliveries failed, and delivers it then', async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    await poll([repository]);
    github.review(901, 'COMMENTED');
    clock += 60_000;
    context.failing.next = 1;
    expect(await poll([repository])).toMatchObject({ failed: 1, delivered: 0 });
    clock += 60_000;
    // Not a 304: the failed answer's ETag was not kept.
    expect(await poll([repository])).toMatchObject({ delivered: 1, failed: 0 });
    expect(context.delivered.map(event => event.deliveryId)).toEqual(['poll:10:pull-request:17:review:901']);
  });

  it('follows the pages of a long review list, and reads comments from the newest one seen on', async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    github.limits.pageSize = 2;
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    await poll([repository]);
    clock += 60_000;
    for (const id of [1, 2, 3, 4, 5]) github.review(id, 'COMMENTED');
    github.comment(70);
    clock += 60_000;
    await poll([repository]);
    expect(context.delivered.map(event => event.deliveryId)).toEqual([
      ...[1, 2, 3, 4, 5].map(id => `poll:10:pull-request:17:review:${id}`),
      'poll:10:pull-request:17:comment:70',
    ]);
    const commentReads = github.reads.filter(read => read.path.includes('/comments'));
    clock += 60_000;
    await poll([repository]);
    const next = github.reads.filter(read => read.path.includes('/comments')).slice(commentReads.length);
    // The next read starts at the newest comment's time.
    expect(next[0]!.path).toContain('since=2030-01-01T01:01:00.000Z');
  });

  it("stops at GitHub's rate limit and reads nothing before it says to resume", async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    github.limits.rateLimitedUntil = clock + 5 * 60_000;
    expect(await poll([repository])).toMatchObject({ rateLimitedUntil: clock + 5 * 60_000, fetched: 0 });
    clock += 60_000;
    github.limits.rateLimitedUntil = 0;
    const reads = github.reads.length;
    expect(await poll([repository])).toMatchObject({ rateLimitedUntil: expect.any(Number) });
    expect(github.reads).toHaveLength(reads);
    clock += 5 * 60_000;
    expect(await poll([repository])).toMatchObject({ fetched: 3 });
  });
});

describe('rateLimitResumeAt', () => {
  it("reads GitHub's own say on when to resume", () => {
    expect(rateLimitResumeAt(403, { 'retry-after': '30' }, 1_000)).toBe(31_000);
    expect(rateLimitResumeAt(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' })).toBe(
      1_700_000_000_000,
    );
    expect(rateLimitResumeAt(429, {}, 1_000)).toBe(61_000);
    // A 403 that is not the rate limit (no access) is not waited out.
    expect(rateLimitResumeAt(403, { 'x-ratelimit-remaining': '4000' })).toBeUndefined();
    expect(rateLimitResumeAt(404, {})).toBeUndefined();
  });
});

describe('GithubEventsSeenStorage', () => {
  it('lets one caller handle an event, gives it back when that failed, and keeps it once handled', async () => {
    const claims = await eventClaims();
    const key = 'github:10:pull-request:17:review:1';
    const first = await claims.claim(key);
    expect(first).toMatchObject({ state: 'taken' });
    // Another caller while the first handles it: busy, not handled.
    expect(await claims.claim(key)).toEqual({ state: 'busy' });
    const token = (first as { token: string }).token;
    // Only the claim's own token finishes it.
    await claims.release(key, 'someone-else');
    expect(await claims.claim(key)).toEqual({ state: 'busy' });
    await claims.release(key, token);
    const again = await claims.claim(key);
    expect(again).toMatchObject({ state: 'taken' });
    await claims.done(key, (again as { token: string }).token);
    await claims.release(key, (again as { token: string }).token);
    expect(await claims.claim(key)).toEqual({ state: 'done' });
  });
});

describe('githubEventContentKey', () => {
  const pr = (extra: Record<string, unknown>) => ({
    event: 'pull_request',
    deliveryId: 'd',
    payload: { repository: { id: 10 }, ...extra },
  });
  it('tells a second close after a reopen from the first, and a push back to a head from the first push', () => {
    const closed = (closedAt: string) =>
      githubEventContentKey(pr({ action: 'closed', pull_request: { number: 17, closed_at: closedAt } }));
    expect(closed('2030-01-01T01:00:00Z')).not.toBe(closed('2030-01-01T02:00:00Z'));
    expect(githubEventContentKey(pr({ action: 'closed', pull_request: { number: 17, merged: true } }))).toBe(
      'github:10:pull-request:17:merged',
    );
    const push = (before: string, after: string) =>
      githubEventContentKey(pr({ action: 'synchronize', before, after, pull_request: { number: 17, head: { sha: after } } }));
    const keys = [push('a', 'b'), push('b', 'a')];
    expect(new Set(keys).size).toBe(2);
    expect(push('a', 'b')).toBe(keys[0]);
  });
});

describe('the poll and the webhook on one event', () => {
  it('delivers a close after a reopen, and a push back to an earlier head, as events of their own', async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    await poll([repository]);
    const head = (sha: string) => ({ ref: 'feature', sha, repo: { id: 10 } });
    for (const sha of ['b'.repeat(40), 'a'.repeat(40)]) {
      Object.assign(github.pull, { head: head(sha) });
      clock += 60_000;
      await poll([repository]);
    }
    for (const closedAt of ['2030-01-01T02:00:00Z', '2030-01-01T03:00:00Z']) {
      Object.assign(github.pull, { state: 'closed', closed_at: closedAt });
      clock += 60_000;
      await poll([repository]);
      Object.assign(github.pull, { state: 'open', closed_at: null });
      clock += 60_000;
      await poll([repository]);
    }
    expect(context.delivered.map(event => `${event.event}:${String(event.payload.action)}`)).toEqual([
      'pull_request:synchronize',
      'pull_request:synchronize',
      'pull_request:closed',
      'pull_request:closed',
    ]);
  });

  it('leaves an event the webhook is handling, and delivers it next tick when the webhook failed', async () => {
    let clock = Date.parse('2030-01-01T01:00:00Z');
    const now = () => clock;
    const github = fakeGithub(now);
    const context = await setup(['review']);
    const poll = createActivePullRequestPoll(context.options, { get: github.get, deliver: context.deliver, now });
    await poll([repository]);
    clock += 30_000;
    github.review(910, 'CHANGES_REQUESTED');
    // The webhook took the review and is handling it.
    const held = await context.claims.claim('github:10:pull-request:17:review:910');
    clock += 30_000;
    expect(await poll([repository])).toMatchObject({ delivered: 0, failed: 0 });
    // It failed and gave it back: the poll reads the reviews again (no 304) and delivers it.
    await context.claims.release('github:10:pull-request:17:review:910', (held as { token: string }).token);
    clock += 60_000;
    expect(await poll([repository])).toMatchObject({ delivered: 1 });
    expect(context.delivered.map(event => event.deliveryId)).toEqual(['poll:10:pull-request:17:review:910']);
  });
});

describe('GithubActivePullRequestPollWorker', () => {
  /** A lease shared by the replicas, as the pubsub's lease provider keeps it. */
  function sharedLease() {
    let owner: string | undefined;
    const calls: string[] = [];
    return {
      calls,
      provider: {
        acquireLease: async (_key: string, who: string) => {
          calls.push('acquire');
          if (owner && owner !== who) return { acquired: false, owner };
          owner = who;
          return { acquired: true, owner };
        },
        renewLease: async (_key: string, who: string) => {
          calls.push('renew');
          return owner === who;
        },
        releaseLease: async (_key: string, who: string) => {
          calls.push('release');
          if (owner === who) owner = undefined;
        },
        getLeaseOwner: async () => owner,
        transferLease: async () => false,
      },
    };
  }
  const worker = async (lease: ReturnType<typeof sharedLease>, preferred?: () => Promise<boolean>) => {
    const poll = vi.fn(async () => ({ pullRequests: 0, fetched: 0, notModified: 0, delivered: 0, failed: 0, errors: [] }));
    const instance = new GithubActivePullRequestPollWorker({
      poll,
      sourceControl: {
        projectRepositories: { listConfiguredExternalKeys: async () => [], listByExternalRepository: async () => [] },
        repositories: { findByExternalId: async () => null },
      },
      intervalMs: 60_000,
      ...(preferred ? { preferred } : {}),
    });
    await instance.init({ pubsub: lease.provider, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
    await instance.start();
    onTestFinished(() => instance.stop());
    return { instance, poll };
  };

  it('keeps its lease from tick to tick, and leaves it to the preferred process at first', async () => {
    const lease = sharedLease();
    const other = await worker(lease, async () => false);
    // Not the process running Claude Agent sessions: it waits before taking the poll.
    expect(await other.instance.tick()).toBeUndefined();
    expect(lease.calls).toEqual([]);

    const host = await worker(lease, async () => true);
    expect(await host.instance.tick()).toBeDefined();
    expect(await host.instance.tick()).toBeDefined();
    expect(lease.calls).toEqual(['acquire', 'renew']);
    expect(host.poll).toHaveBeenCalledTimes(2);
    await host.instance.stop();
    expect(lease.calls.at(-1)).toBe('release');
  });
});
