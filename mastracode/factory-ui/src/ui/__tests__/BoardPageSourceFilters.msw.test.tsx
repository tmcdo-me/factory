import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { openPropertiesMenu, openPropertySubmenu, togglePropertyOption } from '../../../e2e/ui/properties-menu';
import { renderWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';
import { wireSourceCards } from './fixtures/boardSourceFilters';
import { FACTORY_ID, stubWorkBoard } from './workBoardStubs';

function stubSources() {
  stubWorkBoard();
  server.use(
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({ config: { github: { enabled: true, sourceIds: ['acme/app'] } } }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings: [] })),
    http.get(`${TEST_BASE_URL}/web/github/status`, () =>
      HttpResponse.json({ enabled: true, connected: true, installations: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () =>
      HttpResponse.json({ workItems: wireSourceCards }),
    ),
  );
}

function renderBoard(search = '') {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/work${search}`] });
  return { router, ...renderWithProviders(<RouterProvider router={router} />) };
}

async function selectMany(name: string, options: string[]) {
  const user = userEvent.setup();
  for (const option of options) await togglePropertyOption(user, 'Board properties', name, new RegExp(option));
}

async function saveAsView() {
  const user = userEvent.setup();
  await openPropertiesMenu(user, 'Board properties');
  await user.click(screen.getByRole('menuitem', { name: 'Save as view' }));
  await user.click(await screen.findByRole('button', { name: 'Save view' }));
}

async function intakeSourceOptions() {
  await openPropertySubmenu(userEvent.setup(), 'Board properties', 'Intake source');
  return screen.getAllByRole('menuitemcheckbox').map(option => option.textContent);
}

async function expectManualView() {
  await screen.findByText('Manual follow-up');
  expect(
    within(screen.getByTestId('board-column-planning')).getByText('Manual: write release notes'),
  ).toBeInTheDocument();
  for (const title of [
    'Portal: add account switcher',
    'Portal: invite teammates',
    'Portal: workspace settings',
    'Portal: member permissions',
  ]) {
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  }
}

describe('Board source filters', () => {
  it('offers connected providers and Manual, but not unconnected sources', async () => {
    stubSources();
    const view = renderBoard();
    await waitForMutationsIdle(view.client);
    // Pull requests are offered while a code host is connected: they replace the retired Review board.
    expect(await intakeSourceOptions()).toEqual(['GitHub', 'Detail', 'Manual', 'Pull requests']);
  });

  it('keeps a saved filter on a disconnected source labelled and selectable', async () => {
    stubSources();
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: false, installations: [] }),
      ),
    );
    const view = renderBoard('?source=github');
    await waitForMutationsIdle(view.client);
    expect(await intakeSourceOptions()).toEqual(['GitHub', 'Detail', 'Manual']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'GitHub' })).toHaveAttribute('aria-checked', 'true');
  });

  it('offers only Detail and Manual when the configured provider is disconnected', async () => {
    stubSources();
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: false, installations: [] }),
      ),
    );
    const view = renderBoard();
    await waitForMutationsIdle(view.client);
    expect(await intakeSourceOptions()).toEqual(['Detail', 'Manual']);
  });

  it('filters cards across stages, then saves and reloads the view', async () => {
    stubSources();
    const first = renderBoard();
    await screen.findByText('Portal: add account switcher');
    await waitForMutationsIdle(first.client);
    await selectMany('Intake source', ['Manual']);
    await expectManualView();
    expect(first.router.state.location.search).toContain('source=manual');

    await saveAsView();
    const viewId = new URLSearchParams(first.router.state.location.search).get('view');
    expect(viewId).toBeTruthy();
    first.unmount();
    const second = renderBoard(`?view=${viewId}`);
    await waitForMutationsIdle(second.client);
    await expectManualView();
  });

  it('merges selected source feeds and restores all sources after clearing the filter', async () => {
    stubSources();
    const view = renderBoard('?source=github');
    await screen.findByText('Portal: add account switcher');
    await waitForMutationsIdle(view.client);
    expect(screen.queryByText('Manual follow-up')).not.toBeInTheDocument();
    await selectMany('Intake source', ['Manual']);
    await screen.findByText('Manual follow-up');
    expect(screen.getByText('Portal: add account switcher')).toBeInTheDocument();
    await selectMany('Intake source', ['GitHub', 'Manual']);
    await screen.findByText('Manual follow-up');
    expect(screen.getByText('Portal: add account switcher')).toBeInTheDocument();
    expect(view.router.state.location.search).not.toContain('source=');
  });

  it('explains that filters excluded Intake cards instead of suggesting an integration setup', async () => {
    stubSources();
    const view = renderBoard('?source=pull-request');
    await waitForMutationsIdle(view.client);
    await within(screen.getByTestId('board-column-intake')).findByText('No work items match filters');
    expect(
      within(screen.getByTestId('board-column-intake')).getByText(/Try adjusting or clearing your filters\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('No intake sources')).not.toBeInTheDocument();
  });
});
