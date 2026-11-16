/**
 * BDD coverage for the factory Behavior settings page
 * (`/factories/:factoryId/settings/behavior`). The page lives outside any
 * workspace route, so it must address the factory-level session (whose
 * `resourceId` is the factory project id) — a regression here
 * leaves every toggle permanently disabled because no session settings
 * can load.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';

const API = `${TEST_BASE_URL}/api/agent-controller/code`;
const FACTORY_ID = 'fp-1';
const REPO_ID = 'repo-1';
/** The factory-level session address: the factory project id itself. */
const FACTORY_RESOURCE_ID = 'fp-1';

function renderBehaviorSettings() {
  const router = createMemoryRouter(createAppRoutes(), {
    initialEntries: [`/factories/${FACTORY_ID}/settings/behavior`],
  });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

function stubBehaviorPage() {
  const settings = { yolo: false, thinkingLevel: 'medium', notifications: 'bell', smartEditing: true };
  const seen = {
    settingsResourceIds: [] as string[],
    stateWrites: [] as { resourceId: string; body: unknown }[],
  };

  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Mastra',
            repositories: [
              listedRepository(REPO_ID, 'org/mastra', { branch: 'main', sandboxWorkdir: '/workspace/mastra' }),
            ],
          },
        ],
      }),
    ),
    http.post(`${API}/sessions`, async ({ request }) => {
      const { resourceId } = (await request.json()) as { resourceId: string };
      return HttpResponse.json({ controllerId: 'code', resourceId, threadId: 'thread-1' });
    }),
    http.get(`${API}/sessions/:resourceId`, ({ params }) => {
      seen.settingsResourceIds.push(String(params.resourceId));
      return HttpResponse.json({
        controllerId: 'code',
        resourceId: params.resourceId,
        modeId: 'build',
        modelId: 'openai/gpt-4o-mini',
        threadId: 'thread-1',
        settings,
      });
    }),
    http.put(`${API}/sessions/:resourceId/state`, async ({ params, request }) => {
      const body = (await request.json()) as { state?: Record<string, unknown> };
      seen.stateWrites.push({ resourceId: String(params.resourceId), body });
      Object.assign(settings, body.state);
      return HttpResponse.json({});
    }),
  );
  return seen;
}

describe('Behavior settings page (factory scope)', () => {
  it('loads factory-level session settings so the behavior toggles are interactive', async () => {
    const seen = stubBehaviorPage();

    renderBehaviorSettings();

    const smartEditing = await screen.findByRole('switch', { name: 'Smart editing' });
    await waitFor(() => expect(smartEditing).toBeEnabled());
    // fork(claude-agent): tool permissions and auto-approve were dropped with their UI.
    expect(screen.queryByRole('switch', { name: 'Auto-approve tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Read permission' })).not.toBeInTheDocument();
    expect(seen.settingsResourceIds).toContain(FACTORY_RESOURCE_ID);
    // Never address a session with an empty resourceId.
    expect(seen.settingsResourceIds).not.toContain('');
  });

  it('persists a toggle change to the factory-level session', async () => {
    const seen = stubBehaviorPage();
    const user = userEvent.setup();

    renderBehaviorSettings();

    const smartEditing = await screen.findByRole('switch', { name: 'Smart editing' });
    await waitFor(() => expect(smartEditing).toBeEnabled());
    await user.click(smartEditing);

    await waitFor(() => expect(seen.stateWrites).toHaveLength(1));
    expect(seen.stateWrites[0]).toEqual({
      resourceId: FACTORY_RESOURCE_ID,
      body: { state: { smartEditing: false } },
    });
    await waitFor(() => expect(smartEditing).not.toBeChecked());
  });
});
