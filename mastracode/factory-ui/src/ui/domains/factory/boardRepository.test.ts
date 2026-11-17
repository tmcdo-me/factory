import { describe, expect, it } from 'vitest';

import type { LinkedRepositoryPayload } from '../workspaces/services/github';
import { providerFactsCard } from '../../__tests__/fixtures/providerFactsCard';
import { cardProjectRepositoryId, cardRepositorySlug } from './boardRepository';

function repository(externalId: string, slug: string): LinkedRepositoryPayload {
  return {
    projectRepositoryId: slug,
    provider: 'github',
    externalId,
    slug,
    gitBranch: 'main',
    sandboxWorkdir: `/sandbox/${slug}`,
  };
}

describe('cardRepositorySlug', () => {
  it('locates a card repository using normalized provider ids', () => {
    const card = {
      source: 'github-issue',
      metadata: { githubRepositoryId: 202, repository: 'acme/old' },
      workItem: { ...providerFactsCard.workItem, metadata: { githubRepositoryId: 101 } },
    };
    expect(
      cardProjectRepositoryId([repository('101', 'acme/current'), repository('202', 'acme/stale')], card, 'fallback'),
    ).toBe('acme/current');
  });

  describe.each(['github-issue', 'github-pr'])('%s', source => {
    it('uses the repository its provider id names over the stored slug', () => {
      const repositories = [repository('101', 'acme/github')];
      expect(cardRepositorySlug(source, { repository: 'acme/stored', githubRepositoryId: 101 }, repositories)).toBe(
        'acme/github',
      );
    });

    it('falls back to the stored slug when no linked repository has its id', () => {
      const repositories = [repository('303', 'acme/other')];
      expect(cardRepositorySlug(source, { repository: 'acme/stored', githubRepositoryId: 101 }, repositories)).toBe(
        'acme/stored',
      );
      expect(cardRepositorySlug(source, { githubRepositoryId: 101 }, repositories)).toBeUndefined();
    });
  });

  it.each(['slack-thread', 'manual'])('preserves stable-id lookup for %s cards', source => {
    expect(cardRepositorySlug(source, { githubRepositoryId: 101 }, [repository('101', 'acme/github')])).toBe(
      'acme/github',
    );
  });

  it('falls back to the stored slug when the provider id matches multiple repositories', () => {
    const repositories = [repository('101', 'acme/one'), repository('101', 'acme/two')];

    expect(
      cardRepositorySlug('github-issue', { repository: 'acme/stored', githubRepositoryId: 101 }, repositories),
    ).toBe('acme/stored');
    expect(cardRepositorySlug('github-issue', { githubRepositoryId: 101 }, repositories)).toBeUndefined();
  });

  it('treats an unspecified provider as GitHub and preserves zero-valued ids', () => {
    const repositories = [{ ...repository('0', 'acme/renamed'), provider: undefined }];

    expect(cardRepositorySlug('github-issue', { repository: 'acme/old', githubRepositoryId: 0 }, repositories)).toBe(
      'acme/renamed',
    );
    expect(cardRepositorySlug('github-issue', undefined, repositories)).toBeUndefined();
  });
});
