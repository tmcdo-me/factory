import { describe, expect, it } from 'vitest';

import { genericExternalWorkItemUrl } from './workItemPresentation';

describe('genericExternalWorkItemUrl', () => {
  it.each([['github-pr' as const, 'https://github.com/mastra-ai/mastra/pull/20384']])(
    'leaves %s links to the review-specific header action',
    (source, url) => {
      expect(genericExternalWorkItemUrl({ source, url })).toBeUndefined();
    },
  );

  it.each([
    ['github-issue' as const, 'https://github.com/mastra-ai/mastra/issues/20384'],
    ['slack-thread' as const, 'https://acme.slack.com/archives/C123/p1791936483798759'],
  ])('keeps the generic external link for %s work items', (source, url) => {
    expect(genericExternalWorkItemUrl({ source, url })).toBe(url);
  });
});
