import { screen } from '@testing-library/react';
import { Command } from '@mastra/playground-ui/components/Command';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import { CreateFactoryRepositoryRows } from '../create-factory/CreateFactoryRepositoryRows';

afterEach(() => vi.restoreAllMocks());

it('disables the connect action when GitHub is not configured', async () => {
  server.use(
    http.get(`${TEST_BASE_URL}/web/github/status`, () =>
      HttpResponse.json({
        enabled: false,
        connected: false,
        installations: [],
        reason: 'missing_config',
        diagnostics: { missingGithubAppEnvVars: ['GITHUB_APP_ID'] },
      }),
    ),
  );
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);

  renderWithProviders(
    <Command>
      <CreateFactoryRepositoryRows
        query=""
        githubRedirecting={false}
        onConnect={vi.fn()}
        onManageConnection={vi.fn()}
        onSelectRepository={vi.fn()}
      />
    </Command>,
  );

  const github = await screen.findByRole('option', { name: /GitHub unavailable/ });
  expect(github).toHaveAttribute('aria-disabled', 'true');
  expect(github).not.toHaveTextContent('GITHUB_APP_ID');
  expect(open).not.toHaveBeenCalledWith('https://projects.mastra.ai', expect.anything(), expect.anything());
});

it('calls onConnect for GitHub directly without any Platform redirect', async () => {
  server.use(
    http.get(`${TEST_BASE_URL}/web/github/status`, () =>
      HttpResponse.json({
        enabled: true,
        connected: false,
        installations: [],
        reason: 'not_connected',
      }),
    ),
  );
  const onConnect = vi.fn();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);

  renderWithProviders(
    <Command>
      <CreateFactoryRepositoryRows
        query=""
        githubRedirecting={false}
        onConnect={onConnect}
        onManageConnection={vi.fn()}
        onSelectRepository={vi.fn()}
      />
    </Command>,
  );

  const github = await screen.findByRole('option', { name: /Connect GitHub/ });
  await userEvent.setup().click(github);
  expect(onConnect).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalledWith('https://projects.mastra.ai', expect.anything(), expect.anything());
});
