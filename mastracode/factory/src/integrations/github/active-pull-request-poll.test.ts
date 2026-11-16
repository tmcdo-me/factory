// fork(claude-agent): the pull requests of cards in an active column, polled with conditional requests
// for a Factory GitHub can't reach (no webhooks).
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createTriageWorkRegistry } from '../../boards/test-utils.js';
import { createFactoryStorageForTests } from '../../storage/test-utils.js';
import { createActivePullRequestPoll } from './active-pull-request-poll.js';
import type { ConditionalGithubGet } from './active-pull-request-poll.js';
import { resolveGithubRules } from './default-rules.js';
import type { GithubIntegration } from './integration.js';
import { GithubRules, createGithubPullRequestReconciler } from './rules.js';
import type { GithubRulesOptions } from './rules.js';
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
  const resource = (path: string): unknown => {
    if (path === '/repos/acme/repo/pulls/17') return pull;
    if (path === '/repos/acme/repo/pulls/17/reviews?per_page=100') return reviews;
    if (path.startsWith('/repos/acme/repo/issues/17/comments?per_page=100&since=')) {
      const since = Date.parse(decodeURIComponent(path.split('since=')[1]!));
      return comments.filter(comment => Date.parse(String(comment.created_at)) >= since);
    }
    throw Object.assign(new Error(`Not Found: ${path}`), { status: 404 });
  };
  const get: ConditionalGithubGet = async ({ path, etag }) => {
    const body = resource(path);
    const current = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    if (etag === current) {
      reads.push({ path, status: 304 });
      return { status: 304 };
    }
    reads.push({ path, status: 200 });
    return { status: 200, etag: current, data: structuredClone(body) };
  };
  return {
    get,
    reads,
    pull,
    review: (id: number, state: string, submittedAt = new Date(now()).toISOString()) =>
      reviews.push({ id, state, body: 'Please fix the tests.', submitted_at: submittedAt, user: { login: 'reviewer' } }),
    comment: (id: number, createdAt = new Date(now()).toISOString()) =>
      comments.push({ id, body: 'Looks close.', created_at: createdAt, user: { login: 'reviewer' } }),
  };
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
  const delivered: ParsedGithubWebhook[] = [];
  const deliver = async (event: ParsedGithubWebhook) => {
    delivered.push(event);
    await rules.ingest(event);
  };
  const decisions = () => seeded.workItems.listDeferredDecisions('org-1', project.id);
  return { options, deliver, delivered, decisions, card, workItems: seeded.workItems };
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
    // Read again: each is delivered once.
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
});
