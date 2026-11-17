import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { GithubStatus } from '../../../workspaces/services/github';
import { SourceControlConnections } from '../SourceControlConnections';

function githubStatus(status: GithubStatus) {
  server.use(http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(status)));
}

function renderSourceControl() {
  return renderWithProviders(
    <MemoryRouter>
      <SourceControlConnections />
    </MemoryRouter>,
  );
}

const sourceControl = () => screen.getByRole('region', { name: 'Source control' });
const rowOf = (text: string) => {
  const row = within(sourceControl()).getByText(text).closest<HTMLElement>('[data-slot="settings-item"]');
  if (!row) throw new Error(`${text} row is missing`);
  return row;
};

describe('Source control connections', () => {
  beforeEach(() => {
    githubStatus({ enabled: true, connected: false, installations: [], reason: 'ready' });
  });

  it('offers Connect for GitHub while no installation exists', async () => {
    renderSourceControl();
    expect(await within(sourceControl()).findByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    expect(within(sourceControl()).queryByRole('button', { name: 'Manage GitHub connection' })).not.toBeInTheDocument();
  });

  it('lists GitHub installations with Manage instead of Connect once connected', async () => {
    githubStatus({
      enabled: true,
      connected: true,
      installations: [{ installationId: 7, accountLogin: 'acme', accountType: 'Organization' }],
      reason: 'ready',
    });
    renderSourceControl();
    expect(await within(sourceControl()).findByText('acme')).toBeInTheDocument();
    expect(within(rowOf('acme')).getByRole('button', { name: 'Manage GitHub connection' })).toBeEnabled();
    expect(within(sourceControl()).queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });
});
