import { describe, expect, it, vi } from 'vitest';

import { createBoardRegistry } from '../../boards/index.js';
import { FactoryTransitionService } from '../../rules/transition-service.js';
import { createFactoryStorageForTests } from '../../storage/test-utils.js';
import type { GithubIntegration } from './integration.js';
import { recordFactoryPullRequestProvenance } from './provenance.js';
import type { FactoryPullRequestProvenanceData } from './provenance.js';

async function setup() {
  const seeded = await createFactoryStorageForTests();
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const integrationStorage = seeded.integrations.forIntegration<
    Record<string, unknown>,
    Record<string, unknown>,
    FactoryPullRequestProvenanceData
  >('github');
  const project = await seeded.projects.create({
    orgId: 'org-1',
    userId: 'user-1',
    input: { name: 'Project 1' },
  });
  const item = (
    await seeded.workItems.upsert({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: project.id,
      input: {
        externalSource: {
          integrationId: 'github',
          type: 'issue',
          externalId: 'github-issue:42',
          url: 'https://github.com/acme/repo/issues/42',
        },
        title: 'Issue 42',
        stages: ['execute'],
        sessions: {},
        metadata: {},
      },
    })
  ).item;
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: '7',
  });
  const repository = await sourceControl.repositories.upsert({
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
    repositoryId: repository.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  // fork(claude-agent): the run's own branch, in the repository itself.
  const pullsGet = vi.fn().mockResolvedValue({
    data: {
      number: 17,
      html_url: 'https://github.com/acme/repo/pull/17',
      base: { repo: { id: 10 } },
      head: { ref: 'feature', repo: { id: 10 } },
    },
  });
  const github = {
    getInstallationOctokit: vi.fn(() => ({ pulls: { get: pullsGet } })),
  } as unknown as GithubIntegration;
  const input = {
    binding: {
      id: 'binding-1',
      orgId: 'org-1',
      factoryProjectId: project.id,
      workItemId: item.id,
      threadId: 'thread-1',
      resourceId: 'resource-1',
      projectPath: '/workspace',
      branch: 'feature',
      role: 'work',
      status: 'active' as const,
      kickoffKey: 'kickoff-1',
      createdAt: new Date(),
      revokedAt: null,
    },
    item,
    assistantMessageId: 'message-1',
    toolCallId: 'call-1',
    toolName: 'execute_command',
    toolInput: { command: 'gh pr create --title "PR 17" --body "body"' },
    toolResult: { stdout: 'https://github.com/acme/repo/pull/17\n' },
    status: 'success' as const,
  };
  return { sourceControl, integrationStorage, workItems: seeded.workItems, project, github, pullsGet, input };
}

describe('recordFactoryPullRequestProvenance', () => {
  it('records only a verified gh pr create result for the exact bound Factory work item', async () => {
    const { sourceControl, integrationStorage, workItems, project, github, pullsGet, input } = await setup();
    await recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, input);

    expect(pullsGet).toHaveBeenCalledWith({ owner: 'acme', repo: 'repo', pull_number: 17 });
    expect((await integrationStorage.subscriptions.listByTarget('factory-pr-provenance:10:17'))[0]).toMatchObject({
      threadId: 'thread-1',
      data: {
        bindingId: 'binding-1',
        workItemId: input.item.id,
        factoryProjectId: project.id,
        assistantMessageId: 'message-1',
        toolCallId: 'call-1',
      },
    });
  });

  it('repairs a review card created before provenance was recorded', async () => {
    const { sourceControl, integrationStorage, workItems, project, github, input } = await setup();
    const review = await workItems.upsert({
      orgId: 'org-1',
      userId: 'factory-rule-dispatcher',
      factoryProjectId: project.id,
      input: {
        externalSource: {
          integrationId: 'github',
          type: 'pull-request',
          externalId: 'github-pr:17',
          url: 'https://github.com/acme/repo/pull/17',
        },
        title: 'PR 17',
        stages: ['intake'],
        sessions: {},
        metadata: {},
      },
    });

    await recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, input);

    expect((await workItems.get({ orgId: 'org-1', id: review.item.id }))?.parentWorkItemId).toBe(input.item.id);
    // fork(claude-agent): a pull request already on a card of its own is not filed a second time.
    expect((await workItems.get({ orgId: 'org-1', id: input.item.id }))!.workItem.sources).toHaveLength(1);
  });

  it('ignores unrelated command results and API mismatches', async () => {
    const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
    await recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, {
      ...input,
      toolInput: { command: 'gh pr view 17' },
    });
    expect(pullsGet).not.toHaveBeenCalled();

    pullsGet.mockResolvedValueOnce({
      data: { number: 17, html_url: 'https://github.com/other/repo/pull/17', base: { repo: { id: 99 } } },
    });
    await recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, input);
    expect(await integrationStorage.subscriptions.listByTarget('factory-pr-provenance:10:17')).toEqual([]);
  });

  // fork(claude-agent): the run only named it; GitHub says its head is a fork's.
  it("records nothing for a pull request whose head isn't the card's own", async () => {
    const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
    pullsGet.mockResolvedValueOnce({
      data: {
        number: 17,
        html_url: 'https://github.com/acme/repo/pull/17',
        base: { repo: { id: 10 } },
        head: { ref: 'feature', repo: { id: 99 } },
      },
    });
    await recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, input);
    expect(await integrationStorage.subscriptions.listByTarget('factory-pr-provenance:10:17')).toEqual([]);
  });

  it('fails closed when pull request verification is unavailable', async () => {
    const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
    pullsGet.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, input),
    ).resolves.toBeUndefined();
    expect(await integrationStorage.subscriptions.listByTarget('factory-pr-provenance:10:17')).toEqual([]);
  });

  // fork(claude-agent)
  describe('files the pull request on the card whose run opened it', () => {
    /** What GitHub reports for #17: opened from `head` in repository `headRepositoryId`. */
    const pullRequest17 = (head = 'feature', headRepositoryId = 10) => ({
      data: {
        number: 17,
        html_url: 'https://github.com/acme/repo/pull/17',
        state: 'open',
        updated_at: '2030-01-01T00:00:00Z',
        head: { ref: head, sha: 'A'.repeat(40), repo: { id: headRepositoryId } },
        base: { ref: 'main', repo: { id: 10 } },
      },
    });
    const opened = (input: Awaited<ReturnType<typeof setup>>['input'], overrides: Record<string, unknown> = {}) => ({
      ...input,
      toolName: 'source_control_create_change_request',
      toolInput: { title: 'PR 17' },
      toolResult: { url: 'https://github.com/acme/repo/pull/17', number: 17 },
      itemOpen: true,
      ...overrides,
    });
    const agentMove = (
      workItems: Awaited<ReturnType<typeof setup>>['workItems'],
      input: Awaited<ReturnType<typeof setup>>['input'],
      expectedRevision: number,
    ) =>
      new FactoryTransitionService({
        storage: workItems,
        configVersion: 'v1',
        boards: createBoardRegistry(),
      }).transition({
        orgId: 'org-1',
        factoryProjectId: input.binding.factoryProjectId,
        workItemId: input.item.id,
        board: 'work',
        stage: 'pr-review',
        expectedRevision,
        actor: { type: 'agent', bindingId: input.binding.id, role: 'work' },
        ingress: { type: 'agent', identity: `${input.binding.id}:move-${expectedRevision}` },
        cause: 'Opened the pull request; out for review.',
      });
    const sources = async (workItems: Awaited<ReturnType<typeof setup>>['workItems'], id: string) =>
      (await workItems.get({ orgId: 'org-1', id }))!.workItem.sources.map(source => source.sourceType);

    it("so the agent's own move to PR review right after opening it goes through", async () => {
      const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
      pullsGet.mockResolvedValue(pullRequest17());
      // Before the pull request is on the card, the move is refused.
      expect(await agentMove(workItems, input, input.item.revision)).toMatchObject({
        status: 'rejected',
        reason: expect.stringMatching(/holds only cards with a pull request/),
      });

      await expect(
        recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, opened(input)),
      ).resolves.toEqual({ attached: true, attachedAt: expect.any(Date) });

      const card = (await workItems.get({ orgId: 'org-1', id: input.item.id }))!;
      expect(card.workItem.sources.map(source => source.sourceType)).toEqual(['issue', 'pull-request']);
      expect(card.externalSource).toMatchObject({ type: 'issue' });
      // Recorded as the pull request the card has out, as "opened" would, so a lost webhook loses nothing.
      expect(card.metadata).toMatchObject({ openPullRequestNumber: 17, pullRequestHeadSha: 'a'.repeat(40) });
      expect(await agentMove(workItems, input, card.revision)).toMatchObject({ status: 'accepted' });
      expect(await workItems.get({ orgId: 'org-1', id: input.item.id })).toMatchObject({ stages: ['pr-review'] });
    });

    // The tool result is only what the run printed: `echo https://github.com/acme/repo/pull/17` after
    // a `gh pr create` names someone else's pull request just as well.
    it.each([
      ["a fork's pull request, even on a branch named like the run's", pullRequest17('feature', 99)],
      ["a pull request from a branch that is not the card's or the run's", pullRequest17('someone/else')],
    ])('leaves off %s that the result names', async (_name, reported) => {
      const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
      pullsGet.mockResolvedValue(reported);

      // An `execute_command` result, as `gh pr create` reports it, for an open card.
      await expect(
        recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, {
          ...input,
          itemOpen: true,
        }),
      ).resolves.toBeUndefined();
      expect(await sources(workItems, input.item.id)).toEqual(['issue']);
    });

    it("asks GitHub about a pull request that is not the card's once per card revision, not on every read", async () => {
      const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
      pullsGet.mockResolvedValue(pullRequest17('someone/else'));
      const read = async () =>
        recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, {
          ...input,
          item: (await workItems.get({ orgId: 'org-1', id: input.item.id }))!,
          itemOpen: true,
        });

      // Mastra Code reads the latest tool result again on every step.
      for (let step = 0; step < 3; step++) await expect(read()).resolves.toBeUndefined();
      expect(pullsGet).toHaveBeenCalledTimes(1);

      // Once the card changes (it may have gained the session whose branch it is), it is asked again.
      await workItems.update({ orgId: 'org-1', id: input.item.id, userId: 'user-1', patch: { metadata: { note: 1 } } });
      await expect(read()).resolves.toBeUndefined();
      await expect(read()).resolves.toBeUndefined();
      expect(pullsGet).toHaveBeenCalledTimes(2);
      expect(await sources(workItems, input.item.id)).toEqual(['issue']);
    });

    it('leaves it off a finished card', async () => {
      const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
      pullsGet.mockResolvedValue(pullRequest17());

      await expect(
        recordFactoryPullRequestProvenance(
          github,
          sourceControl,
          integrationStorage,
          workItems,
          opened(input, { itemOpen: false }),
        ),
      ).resolves.toBeUndefined();
      expect(await sources(workItems, input.item.id)).toEqual(['issue']);
    });

    it('leaves it off a GitLab card, which keeps only merge requests', async () => {
      const { sourceControl, integrationStorage, workItems, github, input, project, pullsGet } = await setup();
      pullsGet.mockResolvedValue(pullRequest17());
      const gitlab = (
        await workItems.upsert({
          orgId: 'org-1',
          userId: 'user-1',
          factoryProjectId: project.id,
          input: {
            externalSource: {
              integrationId: 'gitlab',
              type: 'issue',
              externalId: 'gitlab-issue:42',
              url: 'https://gitlab.com/acme/repo/-/issues/42',
            },
            title: 'GitLab issue',
            stages: ['execute'],
            sessions: {},
            metadata: {},
          },
        })
      ).item;

      await expect(
        recordFactoryPullRequestProvenance(
          github,
          sourceControl,
          integrationStorage,
          workItems,
          opened(input, { item: gitlab, binding: { ...input.binding, workItemId: gitlab.id } }),
        ),
      ).resolves.toBeUndefined();
      expect(await sources(workItems, gitlab.id)).toEqual(['issue']);
    });

    it('leaves it on the card an earlier "opened" already filed it on', async () => {
      const { sourceControl, integrationStorage, workItems, github, input, project, pullsGet } = await setup();
      pullsGet.mockResolvedValue(pullRequest17());
      const own = await workItems.upsert({
        orgId: 'org-1',
        userId: 'factory-rule-dispatcher',
        factoryProjectId: project.id,
        input: {
          externalSource: {
            integrationId: 'github',
            type: 'pull-request',
            externalId: 'github:10:pull-request:17',
            url: 'https://github.com/acme/repo/pull/17',
          },
          title: 'PR 17',
          stages: ['intake'],
          sessions: {},
          metadata: {},
        },
      });

      await expect(
        recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, opened(input)),
      ).resolves.toBeUndefined();
      expect(await sources(workItems, input.item.id)).toEqual(['issue']);
      // That card is linked back to the one whose run opened it, as before.
      expect((await workItems.get({ orgId: 'org-1', id: own.item.id }))?.parentWorkItemId).toBe(input.item.id);
    });

    it('tries again when the same result is read again after an attach failed, then reports it filed', async () => {
      const { sourceControl, integrationStorage, workItems, github, input, pullsGet } = await setup();
      pullsGet.mockResolvedValue(pullRequest17());
      vi.spyOn(workItems, 'attachSource').mockRejectedValueOnce(new Error('database busy'));

      await expect(
        recordFactoryPullRequestProvenance(github, sourceControl, integrationStorage, workItems, opened(input)),
      ).resolves.toBeUndefined();
      expect(await sources(workItems, input.item.id)).toEqual(['issue']);

      // The step's read failed; the thread's read of the same result files it.
      const again = await recordFactoryPullRequestProvenance(
        github,
        sourceControl,
        integrationStorage,
        workItems,
        opened(input, { item: (await workItems.get({ orgId: 'org-1', id: input.item.id }))! }),
      );
      expect(again).toEqual({ attached: true, attachedAt: expect.any(Date) });
      expect(await sources(workItems, input.item.id)).toEqual(['issue', 'pull-request']);
      expect(await integrationStorage.subscriptions.listByTarget('factory-pr-provenance:10:17')).toHaveLength(1);

      // Read once more with the pull request on the card: reported filed, without asking GitHub again.
      pullsGet.mockClear();
      const card = (await workItems.get({ orgId: 'org-1', id: input.item.id }))!;
      await expect(
        recordFactoryPullRequestProvenance(
          github,
          sourceControl,
          integrationStorage,
          workItems,
          opened(input, { item: card }),
        ),
      ).resolves.toEqual({ attached: true, attachedAt: again!.attachedAt });
      expect(pullsGet).not.toHaveBeenCalled();
    });
  });
});
