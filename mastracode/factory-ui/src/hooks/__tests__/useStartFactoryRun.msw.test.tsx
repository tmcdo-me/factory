import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { providerFactsCard } from '../../ui/__tests__/fixtures/providerFactsCard';
import { useStartFactoryRun } from '../useStartFactoryRun';
import type { StartFactoryRunWorkItem } from '../useStartFactoryRun';

const FACTORY_ID = 'fp-1';

function RouteInner({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}`]}>
      <Routes>
        <Route path="/factories/:factoryId" element={children} />
      </Routes>
    </MemoryRouter>
  );
}

function stubEndpoints(
  repositories: Array<{ id: string; externalId: string; slug: string; provider?: 'github' | 'gitlab' }>,
) {
  const sessionsCreatedFor: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  let started: Record<string, unknown> | undefined;
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Acme Factory',
            repositories: repositories.map(repository =>
              listedRepository(repository.id, repository.slug, {
                integrationId: repository.provider ?? 'github',
                externalId: repository.externalId,
                branch: 'main',
                sandboxWorkdir: '/repo',
              }),
            ),
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({ config: { github: { enabled: true, sourceIds: [] }, linear: { enabled: false } } }),
    ),
    http.patch(`${TEST_BASE_URL}/web/factory/work-items/:id`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return HttpResponse.json({
        workItem: {
          id: 'item-1',
          factoryProjectId: FACTORY_ID,
          externalSource: null,
          title: 'Fix login bug',
          stages: ['intake'],
          stageHistory: [],
          sessions: {},
          metadata: body.metadata,
          revision: 2,
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z',
        },
      });
    }),
    http.post(`${TEST_BASE_URL}/web/source-control/projects/:projectRepositoryId/sessions`, ({ params }) => {
      sessionsCreatedFor.push(String(params.projectRepositoryId));
      return HttpResponse.json({ session: { sessionId: 'session-1', branch: 'factory/item-1', title: null } });
    }),
    http.post(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/runs/start`, async ({ request }) => {
      started = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ prepared: { threadId: 'thread-1' } });
    }),
  );
  return { sessionsCreatedFor, patches, started: () => started };
}

const workItem: StartFactoryRunWorkItem = {
  id: 'item-1',
  role: 'work',
  source: 'github-issue' as const,
  sourceKey: 'github-issue:7',
  title: 'Fix login bug',
  // The card was filed before the repository was renamed from acme/old-name.
  metadata: { number: 7, repository: 'acme/old-name', githubRepositoryId: 101 },
};

describe.each(['github'] as const)('useStartFactoryRun with %s', provider => {
  it.each([
    ['a single linked repository', [{ id: 'repo-1', externalId: '101', slug: 'acme/renamed' }]],
    [
      'several linked repositories',
      [
        { id: 'repo-2', externalId: '202', slug: 'acme/other' },
        { id: 'repo-1', externalId: '101', slug: 'acme/renamed' },
      ],
    ],
  ])('starts a renamed repository card by its normalized provider id with %s', async (_label, repositories) => {
    const providerWorkItem: StartFactoryRunWorkItem = {
      ...workItem,
      source: 'github-issue',
      sourceKey: `${provider}-issue:7`,
      metadata: {
        number: 7,
        repository: 'acme/old-name',
        githubRepositoryId: 202,
        labels: ['stale-label'],
        state: 'closed',
      },
      workItem: {
        ...providerFactsCard.workItem,
        metadata: { githubRepositoryId: 101 },
      },
    };
    const calls = stubEndpoints(repositories.map(repository => ({ ...repository, provider })));
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({
      branch: 'factory/item-1',
      threadTitle: 'Fix login bug',
      workItem: providerWorkItem,
    });

    expect(calls.sessionsCreatedFor).toEqual(['repo-1']);
    expect(calls.patches).toEqual([{ metadata: { repository: 'acme/renamed' } }]);
    expect(calls.started()).toHaveProperty('workItem.input.metadata', { repository: 'acme/renamed' });
  });
});

describe.each(['github-issue', 'github-pr'] as const)('useStartFactoryRun repository fallback for %s', source => {
  it('keeps the sole-repository fallback without metadata', async () => {
    const calls = stubEndpoints([{ id: 'source-repo', provider: 'github', externalId: '101', slug: 'acme/source' }]);
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({
      branch: 'factory/item-1',
      threadTitle: 'Fix login bug',
      workItem: { ...workItem, source, metadata: undefined },
    });

    expect(calls.sessionsCreatedFor).toEqual(['source-repo']);
    expect(calls.started()).toMatchObject({ workItem: { input: { metadata: { repository: 'acme/source' } } } });
  });
});

describe.each(['slack-thread', 'manual'] as const)('useStartFactoryRun fallback for %s', source => {
  it('keeps the sole repository fallback', async () => {
    const calls = stubEndpoints([{ id: 'repo-1', provider: 'github', externalId: '101', slug: 'acme/one' }]);
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({
      branch: 'factory/item-1',
      threadTitle: 'Fix login bug',
      workItem: { ...workItem, source, metadata: undefined },
    });

    expect(calls.sessionsCreatedFor).toEqual(['repo-1']);
    expect(calls.started()).toMatchObject({ workItem: { input: { metadata: { repository: 'acme/one' } } } });
  });
});
