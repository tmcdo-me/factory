// fork(claude-agent): how a Factory follows its pull requests' CI and reviews.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { PullRequestCiSection } from '../PullRequestCiSection';

const CI_FOLLOW = `${TEST_BASE_URL}/web/factory/projects/factory-1/ci-follow`;

describe('Pull request checks setting', () => {
  it('shows status only by default and turns on fixing', async () => {
    let saved: unknown;
    server.use(
      http.put(CI_FOLLOW, async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({ mode: 'autofix', maxAttempts: 3 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PullRequestCiSection factoryId="factory-1" />);
    const picker = await screen.findByRole('combobox', { name: 'Follow pull request checks' });
    expect(picker).toHaveTextContent('Show status');
    expect(screen.getByText(/tries 3 times per pull request/)).toBeInTheDocument();
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Show status and fix' }));
    await waitFor(() => expect(saved).toEqual({ mode: 'autofix' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Follow pull request checks' })).toHaveTextContent(
        'Show status and fix',
      ),
    );
  });

  it('keeps the setting it had when the change is refused', async () => {
    server.use(
      http.put(CI_FOLLOW, () =>
        HttpResponse.json(
          {
            error: 'organization_admin_required',
            message: 'Organization administrator access is required to change how pull requests are followed.',
          },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<PullRequestCiSection factoryId="factory-1" />);
    await user.click(await screen.findByRole('combobox', { name: 'Follow pull request checks' }));
    await user.click(await screen.findByRole('option', { name: 'Off' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Follow pull request checks' })).toHaveTextContent('Show status'),
    );
    expect(screen.getByRole('combobox', { name: 'Follow pull request checks' })).toBeEnabled();
  });
});
