// fork(claude-agent): a card whose Claude Agent session waits for a slot under the server's cap (spec slice 13).
import type { RunQueueResponse } from '@mastra/factory/routes/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';
import { FACTORY_ID, stubWorkBoard, workItem } from './workBoardStubs';

const projectUrl = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}`;

function renderBoard() {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/work`] });
  renderWithProviders(<RouterProvider router={router} />);
}

describe('Board cards waiting for a Claude Agent slot', () => {
  it("labels the card whose session waits with its place in Claude Agent's line", async () => {
    stubWorkBoard();
    const sessionRef = { sessionId: 'session-claude', startedBy: 'user-1', startedAt: '2026-08-04T00:00:00.000Z' };
    server.use(
      http.get(`${projectUrl}/work-items`, () =>
        HttpResponse.json({
          workItems: [
            {
              ...workItem('waiting-card', 'Build the importer', '2026-07-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
              sessions: { work: sessionRef },
            },
            workItem('idle-card', 'Nothing running', '2026-07-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z'),
          ],
        }),
      ),
      http.get(`${projectUrl}/run-queue`, () =>
        HttpResponse.json({
          slots: { scope: 'server', inUse: 2, cap: 4 },
          running: 2,
          claimed: [],
          queuedCount: 0,
          queued: [],
          claudeAgent: {
            cap: 1,
            running: 1,
            waiting: [
              { sessionId: 'session-claude', position: 2, priority: 'factory', since: '2026-08-04T00:01:00.000Z' },
            ],
          },
        } satisfies RunQueueResponse),
      ),
    );
    renderBoard();

    const column = await screen.findByTestId('board-column-triage');
    const card = await within(column).findByRole('article', { name: 'Build the importer' });
    expect(await within(card).findByText('Queued (#2)')).toBeInTheDocument();
    const idle = within(column).getByRole('article', { name: 'Nothing running' });
    expect(within(idle).queryByText(/Queued/)).not.toBeInTheDocument();
  });
});
