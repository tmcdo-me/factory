import { describe, expect, it } from 'vitest';

import { externalSourceForWorkItem, factoryRuleSourceForWorkItem, workItemSource } from './rules/types.js';
import { pullRequestNumberFromBranch, workItemBranch, workItemBranchSource } from './work-item-branch.js';

describe('workItemBranchSource', () => {
  it('maps stored provenance onto the branch vocabulary', () => {
    expect(workItemBranchSource(null)).toBe('manual');
    expect(workItemBranchSource({ integrationId: 'github', type: 'issue', externalId: '1' })).toBe('github-issue');
    expect(workItemBranchSource({ integrationId: 'github', type: 'pull-request', externalId: '2' })).toBe('github-pr');
    expect(workItemBranchSource({ integrationId: 'slack', type: 'slack-thread', externalId: '5' })).toBe('manual');
    // A card an integration this server no longer runs filed (a stored Linear row, say) is plain work.
    expect(workItemBranchSource({ integrationId: 'linear', type: 'issue', externalId: '3' })).toBe('manual');
  });

  it('preserves Detail finding provenance through storage, rules, and branches', () => {
    const source = externalSourceForWorkItem('detail-finding', 'repo-1:finding-2', 'https://example.com/finding');
    expect(source).toEqual({
      integrationId: 'detail',
      type: 'finding',
      externalId: 'repo-1:finding-2',
      url: 'https://example.com/finding',
    });
    expect(workItemSource(source)).toBe('detail-finding');
    expect(factoryRuleSourceForWorkItem('detail-finding')).toBe('detailFinding');
    expect(workItemBranchSource(source)).toBe('detail-finding');
  });
});

describe('workItemBranch', () => {
  const id = '9f1c3b2a-0000-4000-8000-000000000001';

  it('names github issue and pull request branches from their metadata number and the item', () => {
    expect(workItemBranch({ id, source: 'github-issue', metadata: { githubIssueNumber: 49 } })).toBe(
      'factory/issue-49-000000000001',
    );
    expect(workItemBranch({ id, source: 'github-pr', metadata: { githubPullRequestNumber: 7 } })).toBe(
      'factory/pr-7-000000000001',
    );
  });

  it('keeps the same github number apart across the repositories of one factory', () => {
    const inApi = workItemBranch({
      id: 'aaaaaaaa-0000-4000-8000-00000000000a',
      source: 'github-issue',
      metadata: { githubIssueNumber: 13, githubRepositoryId: 'repo-api' },
    });
    const inWeb = workItemBranch({
      id: 'bbbbbbbb-0000-4000-8000-00000000000b',
      source: 'github-issue',
      metadata: { githubIssueNumber: 13, githubRepositoryId: 'repo-web' },
    });
    expect(inApi).not.toBe(inWeb);
    expect(inApi).toMatch(/^factory\/issue-13-[a-z0-9]{1,12}$/);
  });

  it.each(['github-issue', 'github-pr'] as const)('keeps %s branches stable for the same card', source => {
    const card = { id, source, metadata: { number: 13 } };
    expect(workItemBranch(card)).toBe(
      workItemBranch({ ...card, metadata: { number: 13, repository: 'renamed/repo' } }),
    );
  });

  it('accepts the intake fallback `number` key for github cards', () => {
    expect(workItemBranch({ id, source: 'github-issue', metadata: { number: 12 } })).toBe(
      'factory/issue-12-000000000001',
    );
  });

  it('rejects numbers that are not positive integers', () => {
    expect(workItemBranch({ id, source: 'github-issue', metadata: { githubIssueNumber: 0 } })).toBe(
      `factory/item-${id}`,
    );
    expect(workItemBranch({ id, source: 'github-issue', metadata: { githubIssueNumber: '49' } })).toBe(
      `factory/item-${id}`,
    );
  });

  it('falls back to an id-derived branch when no provider identity applies', () => {
    expect(workItemBranch({ id, source: 'manual', metadata: null })).toBe(`factory/item-${id}`);
    expect(workItemBranch({ id, source: 'slack-thread' })).toBe(`factory/item-${id}`);
    expect(workItemBranch({ id, source: 'github-issue', metadata: {} })).toBe(`factory/item-${id}`);
  });
});

describe('pullRequestNumberFromBranch', () => {
  it('reads the number back from a pull request branch only', () => {
    expect(pullRequestNumberFromBranch('factory/pr-7-000000000001')).toBe(7);
    expect(pullRequestNumberFromBranch('factory/pr-7')).toBe(7);
    expect(pullRequestNumberFromBranch('factory/issue-7')).toBeUndefined();
    expect(pullRequestNumberFromBranch('factory/issue-7-000000000001')).toBeUndefined();
    expect(pullRequestNumberFromBranch('factory/pr-0')).toBeUndefined();
    expect(pullRequestNumberFromBranch('factory/pr-7x')).toBeUndefined();
    expect(pullRequestNumberFromBranch('factory/pr-7-unsafe!')).toBeUndefined();
    for (const branch of [
      'factory/pr-7-',
      'factory/pr-7-abcdefghijklm',
      'factory/pr-7-ABC',
      'factory/pr-9007199254740992-abc',
      'factory/pr-07-abc',
    ]) {
      expect(pullRequestNumberFromBranch(branch)).toBeUndefined();
    }
    expect(pullRequestNumberFromBranch('feat/pr-7')).toBeUndefined();
  });

  it('round-trips the branch workItemBranch names a pull request card', () => {
    const branch = workItemBranch({
      id: '9f1c3b2a-0000-4000-8000-000000000001',
      source: 'github-pr',
      metadata: { githubPullRequestNumber: 310 },
    });
    expect(pullRequestNumberFromBranch(branch)).toBe(310);
  });
});
