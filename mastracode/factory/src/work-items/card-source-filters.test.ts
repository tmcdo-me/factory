import { describe, expect, it } from 'vitest';

import { hasEveryLabel, metadataLabels } from './card-labels.js';
import { boardSource, matchesSourceFilters, PULL_REQUEST_SOURCE_FILTER } from './card-source-filters.js';
import type { SourceFacts } from './card-source-filters.js';

function filters(source: string[] = []) {
  return { source: new Set(source) };
}

function card(source: SourceFacts['source'], more: { hasPullRequest?: boolean } = {}) {
  return { source, metadata: {}, hasPullRequest: more.hasPullRequest ?? false };
}

describe('boardSource', () => {
  it.each([
    ['github-issue', 'github'],
    ['github-pr', 'github'],
    ['detail-finding', 'detail'],
    ['slack-thread', 'slack'],
    ['manual', 'manual'],
  ] as const)('files a %s card under %s', (source, filedUnder) => {
    expect(boardSource(source)).toBe(filedUnder);
  });
});

describe('matchesSourceFilters', () => {
  it('keeps every card when nothing is picked', () => {
    expect(matchesSourceFilters(card('manual'), filters())).toBe(true);
    expect(matchesSourceFilters(card('detail-finding'), filters())).toBe(true);
  });

  it('keeps the cards of any picked source', () => {
    const picked = filters(['github', 'manual']);

    expect(matchesSourceFilters(card('github-pr'), picked)).toBe(true);
    expect(matchesSourceFilters(card('manual'), picked)).toBe(true);
    expect(matchesSourceFilters(card('detail-finding'), picked)).toBe(false);
    // A Slack thread is not a card filed by hand.
    expect(matchesSourceFilters(card('slack-thread'), picked)).toBe(false);
  });

  it('keeps every card that has a pull request when pull requests are picked, whatever filed it', () => {
    const picked = filters([PULL_REQUEST_SOURCE_FILTER]);

    expect(matchesSourceFilters(card('slack-thread', { hasPullRequest: true }), picked)).toBe(true);
    expect(matchesSourceFilters(card('manual', { hasPullRequest: true }), picked)).toBe(true);
    expect(matchesSourceFilters(card('github-issue'), picked)).toBe(false);
  });
});

describe('card labels', () => {
  it('reads the text labels a source put on an item', () => {
    expect(metadataLabels({ labels: ['bug', 7, null, 'Memory'] })).toEqual(['bug', 'Memory']);
    expect(metadataLabels({ labels: 'bug' })).toEqual([]);
    expect(metadataLabels({})).toEqual([]);
  });

  it('needs every picked label on the item', () => {
    const labels = new Set(['bug', 'Memory']);

    expect(hasEveryLabel(labels, [])).toBe(true);
    expect(hasEveryLabel(labels, ['bug', 'Memory'])).toBe(true);
    expect(hasEveryLabel(labels, ['bug', 'docs'])).toBe(false);
    expect(hasEveryLabel(labels, ['memory'])).toBe(false);
  });
});
