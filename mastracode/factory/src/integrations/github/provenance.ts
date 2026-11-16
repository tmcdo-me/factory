import { cardOwnsBranch } from '../../boards/semantics.js';
import { externalSourceForWorkItem } from '../../rules/types.js';
import type { FactoryRuleJsonValue } from '../../rules/types.js';
import type { IntegrationStorageHandle } from '../../storage/domains/integrations/base.js';
import type { SourceControlStorageHandle } from '../../storage/domains/source-control/base.js';
import { WorkItemSourceConflictError } from '../../storage/domains/work-items/base.js';
import type { FactoryRunBindingRecord, Card, WorkItemsStorage } from '../../storage/domains/work-items/base.js';
import type { GithubIntegration } from './integration.js';
import { isRepositoryPullRequest } from './pull-request-source.js';
import { cardBelongsToRepository } from './rules.js';
import { parseCreatedPullRequest } from './session-subscriptions.js';

export interface RecordFactoryPullRequestProvenanceInput {
  binding: FactoryRunBindingRecord;
  item: Card;
  assistantMessageId: string;
  toolCallId: string;
  toolName: string;
  toolInput: FactoryRuleJsonValue;
  toolResult: FactoryRuleJsonValue;
  status: 'success' | 'error';
  /**
   * fork(claude-agent): whether the card is still open (not in a terminal phase). Only an open card
   * takes the pull request its run opened; a finished card's pull request gets a card of its own.
   */
  itemOpen?: boolean;
}

/**
 * fork(claude-agent): the pull request a tool result opened is on the card, attached at
 * `attachedAt` (now, or by an earlier read of the same result).
 */
export interface FactoryOwnPullRequestAttachment {
  attached: true;
  attachedAt: Date;
}

export interface FactoryPullRequestProvenanceData {
  kind: 'factory-pr-provenance';
  bindingId: string;
  workItemId: string;
  factoryProjectId: string;
  repositoryId: number;
  pullRequestNumber: number;
  pullRequestUrl: string;
  assistantMessageId: string;
  toolCallId: string;
}

export async function resolveFactoryPullRequestParentWorkItemId(
  integrationStorage: IntegrationStorageHandle<
    Record<string, unknown>,
    Record<string, unknown>,
    FactoryPullRequestProvenanceData
  >,
  input: { orgId: string; factoryProjectId: string; repositoryId: number; pullRequestNumber: number },
): Promise<string | null> {
  const targetKey = `factory-pr-provenance:${input.repositoryId}:${input.pullRequestNumber}`;
  // Provenance is scoped to the Factory project whose run authored the PR.
  // Rows from a sibling project in the same org — or legacy rows without the
  // project stamp — fail closed rather than linking another project's card.
  const provenance = (await integrationStorage.subscriptions.listByTarget(targetKey, { status: 'active' })).find(
    row =>
      row.orgId === input.orgId &&
      row.data?.kind === 'factory-pr-provenance' &&
      row.data.factoryProjectId === input.factoryProjectId,
  );
  return provenance?.data?.workItemId ?? null;
}

export async function recordFactoryPullRequestProvenance(
  github: GithubIntegration,
  sourceControl: SourceControlStorageHandle,
  integrationStorage: IntegrationStorageHandle<
    Record<string, unknown>,
    Record<string, unknown>,
    FactoryPullRequestProvenanceData
  >,
  workItems: WorkItemsStorage,
  input: RecordFactoryPullRequestProvenanceInput,
  // fork(claude-agent): set when the pull request is on the card that opened it.
): Promise<FactoryOwnPullRequestAttachment | void> {
  let attached: FactoryOwnPullRequestAttachment | undefined;
  if (input.status !== 'success' || input.item.externalSource?.type === 'pull-request') return;
  const url = parseCreatedPullRequest({
    toolName: input.toolName,
    input: input.toolInput,
    output: input.toolResult,
  });
  if (!url) return;

  try {
    const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i);
    if (!match) return;
    const repositorySlug = match[1]!;
    let repositoryId: number | undefined;
    let installationId: number | undefined;
    for (const connection of await sourceControl.connections.list({
      orgId: input.binding.orgId,
      factoryProjectId: input.binding.factoryProjectId,
    })) {
      const installation = await sourceControl.installations.get({
        orgId: input.binding.orgId,
        id: connection.installationId,
      });
      if (!installation) continue;
      for (const link of await sourceControl.projectRepositories.list({
        orgId: input.binding.orgId,
        connectionId: connection.id,
      })) {
        const repository = await sourceControl.repositories.get({ orgId: input.binding.orgId, id: link.repositoryId });
        if (!repository || repository.slug.toLowerCase() !== repositorySlug.toLowerCase()) continue;
        repositoryId = Number(repository.externalId);
        installationId = Number(installation.externalId);
        break;
      }
      if (repositoryId !== undefined) break;
    }
    const pullRequestNumber = Number(match[2]);
    const [owner, repo] = repositorySlug.split('/');
    if (
      !owner ||
      !repo ||
      repositoryId === undefined ||
      installationId === undefined ||
      !Number.isInteger(repositoryId) ||
      !Number.isInteger(installationId) ||
      !Number.isInteger(pullRequestNumber) ||
      pullRequestNumber < 1
    )
      return;
    const targetKey = `factory-pr-provenance:${repositoryId}:${pullRequestNumber}`;
    // Dedupe within the authoring project only: a sibling project's row must
    // not block this project from recording its own provenance.
    const recorded = (await integrationStorage.subscriptions.listByTarget(targetKey)).find(
      row => row.orgId === input.binding.orgId && row.data?.factoryProjectId === input.binding.factoryProjectId,
    );
    if (recorded) {
      // fork(claude-agent): the same result read again (the step, then the thread) says the pull
      // request is on the card, so a hand-off to review that failed last time is tried again; or,
      // when an earlier attach failed, it is attempted once more below.
      if (recorded.data?.workItemId !== input.item.id) return;
      const held = input.item.workItem.sources.find(source =>
        isRepositoryPullRequest(source, repositoryId, repositorySlug, pullRequestNumber),
      );
      if (held) return held.role === 'attached' ? { attached: true, attachedAt: held.createdAt } : undefined;
      if (input.itemOpen !== true) return;
    }

    const { data } = await github
      .getInstallationOctokit(installationId)
      .pulls.get({ owner, repo, pull_number: pullRequestNumber });
    if (data.base.repo.id !== repositoryId || data.number !== pullRequestNumber || data.html_url !== url) return;

    if (!recorded) {
      await integrationStorage.subscriptions.create({
        orgId: input.binding.orgId,
        targetKey,
        threadId: input.binding.threadId,
        status: 'active',
        data: {
          kind: 'factory-pr-provenance',
          bindingId: input.binding.id,
          workItemId: input.item.id,
          factoryProjectId: input.binding.factoryProjectId,
          repositoryId,
          pullRequestNumber,
          pullRequestUrl: url,
          assistantMessageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
        },
      });
    }

    const reviewItem = (
      await workItems.listShared({
        orgId: input.binding.orgId,
        factoryProjectId: input.binding.factoryProjectId,
      })
    ).find(
      item =>
        item.externalSource?.integrationId === 'github' &&
        item.externalSource.type === 'pull-request' &&
        (item.externalSource.externalId === `github:${repositoryId}:pull-request:${pullRequestNumber}` ||
          (item.externalSource.externalId === `github-pr:${pullRequestNumber}` &&
            cardBelongsToRepository(item, repositoryId, repositorySlug))),
    );
    if (reviewItem) {
      await workItems.setParentWorkItemIfMissing({
        orgId: input.binding.orgId,
        id: reviewItem.id,
        userId: 'factory-pr-provenance',
        parentWorkItemId: input.item.id,
      });
    } else {
      // fork(claude-agent): no card holds the pull request yet, so the card whose run opened it
      // takes it now, from the tool result, rather than when GitHub's "opened" arrives (a webhook,
      // or a reconcile minutes later): the card's handoff to its board's pull request review needs
      // the pull request on it. The "opened" event later finds it filed there and files nothing.
      attached = await attachOwnPullRequest(workItems, input, { repositoryId, repositorySlug, url, pullRequest: data });
    }
  } catch {
  }
  return attached;
}

/**
 * fork(claude-agent): files the pull request a card's own run just opened on that card, as an
 * attached source keyed exactly as GitHub's "opened" files it (`github:<repo>:pull-request:<n>`),
 * and records it as the pull request the card has out, so that event finds both done.
 *
 * The tool result only names a URL, and a run can be made to print any URL, so the pull request
 * GitHub reports must prove it is this card's: its head lives in the base repository (not a fork)
 * and is the card's own branch (its build branch, a session's, or the run binding's). It is
 * skipped for a finished card, for a card that keeps other records only (a GitLab card, a GitHub
 * card from another repository), and when another card already holds the pull request (an
 * "opened" that won the race filed it on a card of its own). Never throws: the event path still
 * files the pull request when this could not.
 */
async function attachOwnPullRequest(
  workItems: WorkItemsStorage,
  input: RecordFactoryPullRequestProvenanceInput,
  created: { repositoryId: number; repositorySlug: string; url: string; pullRequest: unknown },
): Promise<FactoryOwnPullRequestAttachment | undefined> {
  const { item, binding } = input;
  if (workItems.legacyMode || binding.workItemId !== item.id || input.itemOpen !== true) return undefined;
  const own = item.externalSource;
  if (own?.integrationId === 'gitlab') return undefined;
  if (own?.integrationId === 'github' && !cardBelongsToRepository(item, created.repositoryId, created.repositorySlug)) {
    return undefined;
  }
  const pullRequest = record(created.pullRequest);
  const number = pullRequest.number;
  const head = record(pullRequest.head);
  const headBranch = typeof head.ref === 'string' ? head.ref : undefined;
  if (typeof number !== 'number' || !headBranch || record(head.repo).id !== created.repositoryId) return undefined;
  if (!cardOwnsBranch(item, headBranch) && binding.branch !== headBranch) return undefined;
  try {
    // Already on the card (`attached: false`) counts: the card holds its pull request either way.
    const result = await workItems.attachSource({
      orgId: binding.orgId,
      id: item.id,
      source: externalSourceForWorkItem(
        'github-pr',
        `github:${created.repositoryId}:pull-request:${number}`,
        created.url,
      ),
      metadata: pullRequestSourceFacts(created.repositoryId, pullRequest),
    });
    const source = result?.item.workItem.sources.find(entry =>
      isRepositoryPullRequest(entry, created.repositoryId, created.repositorySlug, number),
    );
    if (!result || source?.role !== 'attached') return undefined;
    // The pull request the card has out, as "opened" records it; that event then leaves it be.
    if (result.item.metadata?.openPullRequestNumber !== number) {
      await workItems.update({
        orgId: binding.orgId,
        id: item.id,
        userId: 'factory-pr-provenance',
        patch: {
          metadata: {
            openPullRequestNumber: number,
            pullRequestHeadSha: typeof head.sha === 'string' ? head.sha.toLowerCase() : null,
            pullRequestHeadAt: typeof pullRequest.updated_at === 'string' ? pullRequest.updated_at : null,
          },
        },
      });
    }
    return { attached: true, attachedAt: source.createdAt };
  } catch (error) {
    if (!(error instanceof WorkItemSourceConflictError)) {
      console.warn(`[factory] could not file pull request ${created.url} on card ${item.id}:`, error);
    }
    return undefined;
  }
}

/** The provider facts GitHub's "opened" files a pull request with, read from the API's pull request. */
function pullRequestSourceFacts(repositoryId: number, pullRequest: Record<string, unknown>): Record<string, unknown> {
  const head = record(pullRequest.head);
  const base = record(pullRequest.base);
  const logins = (value: unknown) =>
    Array.isArray(value)
      ? value.map(entry => record(entry).login).filter((login): login is string => typeof login === 'string')
      : [];
  const author = record(pullRequest.user).login;
  return {
    githubRepositoryId: repositoryId,
    githubPullRequestNumber: pullRequest.number,
    ...(typeof pullRequest.created_at === 'string' ? { sourceCreatedAt: pullRequest.created_at } : {}),
    state: pullRequest.state === 'closed' ? 'closed' : 'open',
    draft: pullRequest.draft === true,
    merged: pullRequest.merged === true,
    assignees: logins(pullRequest.assignees),
    requestedReviewers: logins(pullRequest.requested_reviewers),
    labels: Array.isArray(pullRequest.labels)
      ? pullRequest.labels.map(label => record(label).name).filter((name): name is string => typeof name === 'string')
      : [],
    headBranch: typeof head.ref === 'string' ? head.ref : '',
    baseBranch: typeof base.ref === 'string' ? base.ref : '',
    ...(typeof author === 'string' ? { author } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
