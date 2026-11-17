/**
 * A card's button is a move: it transitions the card into the lane whose rule
 * runs the work, and the lane's own button re-enters it. Nothing here starts a
 * run directly — the server's rules do, off the transition.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { workBoardInfo } from '../../../e2e/ui/board-catalog';
import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';
import { providerFactsCard } from './fixtures/providerFactsCard';

const FACTORY_ID = 'fp-1';
const REPO_ID = 'repo-1';

// Wire shape as served by /web/factory/*/work-items: the client derives
// `source`/`url` from `externalSource` (see fromWireWorkItem).
const issueWorkItem = {
  id: 'item-1',
  orgId: 'org-1',
  createdBy: 'user-1',
  factoryProjectId: FACTORY_ID,
  externalSource: {
    integrationId: 'github',
    type: 'issue',
    externalId: 'github-issue:7',
    url: 'https://github.com/acme/app/issues/7',
  },
  parentWorkItemId: null,
  title: 'Fix login bug',
  stages: ['triage'],
  stageHistory: [],
  sessions: {},
  metadata: { number: 7 },
  revision: 1,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const intakeWorkItem = { ...issueWorkItem, stages: ['intake'] };

interface TransitionRequest {
  itemId: string;
  body: Record<string, unknown>;
}

/** Stubs the board's data endpoints and captures everything a card click writes. */
function stubBoardEndpoints({ workItems = [issueWorkItem] as object[], multiRepository = false } = {}) {
  const transitions: TransitionRequest[] = [];
  const patches: Array<{ itemId: string; body: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];

  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Acme Factory',
            repositories: [
              listedRepository(REPO_ID, 'acme/app', { branch: 'main', sandboxWorkdir: '/repo' }),
              ...(multiRepository ? [listedRepository('repo-2', 'acme/other', { branch: 'main' })] : []),
            ],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () => HttpResponse.json({ workItems })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/decisions`, () =>
      HttpResponse.json({ decisions: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({
        config: { github: { enabled: true, sourceIds: ['acme/app'] } },
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings: [] })),
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:resourceId/permissions`, () =>
      HttpResponse.json({ categories: {}, tools: {} }),
    ),
    // The label-filtered (status: auto-triaged) feed stays empty; the plain feed
    // serves the candidate under test.
    http.get(`${TEST_BASE_URL}/web/github/projects/${REPO_ID}/issues/:number`, ({ params }) =>
      HttpResponse.json({
        number: Number(params.number),
        title: 'Crash on logout',
        url: `https://github.com/acme/app/issues/${String(params.number)}`,
        author: 'octocat',
        labels: [],
        comments: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        description: 'The app crashes when logging out.',
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/projects/${REPO_ID}/prs/:number`, () =>
      HttpResponse.json({ error: 'pull_request_not_found' }, { status: 404 }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sessions`, () => HttpResponse.json({ sessions: [] })),
    http.post(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      return HttpResponse.json({
        workItem: { ...issueWorkItem, id: 'item-filed', title: String(body.title), stages: ['intake'] },
      });
    }),
    http.patch(`${TEST_BASE_URL}/web/factory/work-items/:itemId`, async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ itemId: String(params.itemId), body });
      return HttpResponse.json({
        workItem: {
          ...issueWorkItem,
          id: String(params.itemId),
          revision: 5,
          ...(body.metadata ? { metadata: body.metadata } : {}),
        },
      });
    }),
    http.post(
      `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items/:itemId/transition`,
      async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        transitions.push({ itemId: String(params.itemId), body });
        return HttpResponse.json({
          result: {
            status: 'accepted',
            transitionId: `transition-${transitions.length}`,
            itemId: String(params.itemId),
            revision: 9,
            stage: body.stage,
            decisions: [],
          },
        });
      },
    ),
  );

  return { transitions, patches, created };
}

function renderWorkBoard() {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/work`] });
  return renderWithProviders(<RouterProvider router={router} />);
}

async function moveFromCardDetails(cardTitle: string, action: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Details for ${cardTitle}` }));

  const dialog = await screen.findByRole('dialog', { name: cardTitle });
  await user.click(within(dialog).getByRole('button', { name: action }));
}

describe('Board card buttons move the card', () => {
  it('issues a transition to Triage with cause card_action when Investigate is clicked', async () => {
    const { transitions } = stubBoardEndpoints({ workItems: [intakeWorkItem] });
    renderWorkBoard();

    await moveFromCardDetails('Fix login bug', 'Investigate');

    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(transitions[0]).toMatchObject({
      itemId: 'item-1',
      body: { board: 'work', stage: 'triage', cause: 'card_action', expectedRevision: 1 },
    });
    expect(transitions[0]?.body).not.toHaveProperty('reenter');
  });

  it('patches only the chosen repository when moving a normalized card with stale provider metadata', async () => {
    const item = {
      ...issueWorkItem,
      id: 'stale-item-1',
      title: 'Fix stale sync',
      stages: ['intake'],
      metadata: { number: 9, labels: ['stale-label'], state: 'closed', githubRepositoryId: 202 },
      workItem: {
        ...providerFactsCard.workItem,
        provider: 'github',
        title: 'Fix stale sync',
        key: 'acme/app#9',
        state: 'open',
        labels: ['bug'],
        metadata: {},
      },
    };
    const { patches, transitions } = stubBoardEndpoints({ multiRepository: true, workItems: [item] });
    renderWorkBoard();

    await moveFromCardDetails(item.title, 'Investigate');
    const dialog = await screen.findByRole('dialog', { name: 'Choose a repository' });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: /acme\/other/ }));

    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(patches).toEqual([{ itemId: item.id, body: { metadata: { repository: 'acme/other' } } }]);
    expect(transitions[0]).toMatchObject({
      itemId: item.id,
      body: { stage: 'triage', cause: 'card_action', expectedRevision: 5 },
    });
  });

  it("re-enters the lane when the card's own lane button is clicked", async () => {
    const { transitions } = stubBoardEndpoints();
    renderWorkBoard();

    await moveFromCardDetails('Fix login bug', 'Investigate');

    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(transitions[0]?.body).toMatchObject({ stage: 'triage', cause: 'card_action', reenter: true });
  });

  it('offers only explicit card moves without hands-off approval shortcuts', async () => {
    stubBoardEndpoints();
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions for Fix login bug' }));

    expect(await screen.findByRole('menuitem', { name: 'Investigate' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Plan' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /hands-off/i })).not.toBeInTheDocument();
  });

  it("keeps Work's moves against a server older than the board loop", async () => {
    // A server from before the catalog named each board's loop parts sends no `flow` for Work.
    const { flow: _flow, ...olderWork } = workBoardInfo;
    const { transitions } = stubBoardEndpoints({ workItems: [intakeWorkItem] });
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/boards`, () =>
        HttpResponse.json({ boards: [olderWork] }),
      ),
    );
    renderWorkBoard();

    await moveFromCardDetails('Fix login bug', 'Investigate');

    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(transitions[0]).toMatchObject({ itemId: 'item-1', body: { board: 'work', stage: 'triage' } });
  });

  it('offers no hands-off twin for Prepare approval, whose outcome is a maintainer decision', async () => {
    stubBoardEndpoints({
      workItems: [
        { ...issueWorkItem, metadata: { number: 7, labels: ['status: needs approval'] }, stages: ['triage'] },
      ],
    });
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions for Fix login bug' }));
    await screen.findByRole('menuitem', { name: 'Prepare approval' });
    expect(screen.queryByRole('menuitem', { name: 'Prepare approval hands-off' })).not.toBeInTheDocument();
  });

  it('offers the ordinary runs once a person moved a labelled card into a working lane, before the label catches up', async () => {
    stubBoardEndpoints({
      workItems: [
        {
          ...issueWorkItem,
          metadata: { number: 7, labels: ['status: needs approval'] },
          stages: ['planning'],
        },
      ],
    });
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions for Fix login bug' }));
    await screen.findByRole('menuitem', { name: 'Build' });
    expect(screen.queryByRole('menuitem', { name: 'Prepare approval' })).not.toBeInTheDocument();
  });

  it("sets the headings of a card's description under the card's title in its details", async () => {
    stubBoardEndpoints({
      workItems: [
        {
          ...issueWorkItem,
          id: 'manual-item-1',
          externalSource: null,
          title: 'Fix intake sync',
          description: '# Steps\n\nRun the sync twice.',
        },
      ],
    });
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Details for Fix intake sync' }));

    const dialog = await screen.findByRole('dialog', { name: 'Fix intake sync' });
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Fix intake sync' })).toBeInTheDocument();
    expect(await within(dialog).findByRole('heading', { level: 4, name: 'Steps' })).toBeInTheDocument();
  });

  it('links the card source from the panel header', async () => {
    stubBoardEndpoints();
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Details for Fix login bug' }));

    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    expect(within(dialog).getByRole('link', { name: 'Open in GitHub: #7' })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/issues/7',
    );
  });
});
