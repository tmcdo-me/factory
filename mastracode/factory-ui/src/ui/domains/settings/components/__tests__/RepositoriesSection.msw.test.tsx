import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listedRepository } from '../../../../../../e2e/ui/factory-projects';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { RepositoriesSection } from '../RepositoriesSection';
import { environmentPayload, environmentRepository } from './fixtures/environment';

const FACTORY_ID = 'fp-1';
const PRIMARY_PROJECT = 'acme/factory-primary';
const primaryRepository = listedRepository('repo-1', PRIMARY_PROJECT, {
  branch: 'main',
  sandboxWorkdir: '~/factory-primary',
});
const controlRepository = {
  id: 20,
  fullName: 'acme/factory-control',
  name: 'factory-control',
  owner: 'acme',
  defaultBranch: 'main',
  private: true,
  installationId: 1,
  installationStorageId: 'inst-1',
  sandboxProvider: 'custom',
  sandboxWorkdir: '~/factory-control',
};
/** GitHub connected, listing one repository the Factory has not linked yet. */
const githubListingControl = () => [
  http.get(`${TEST_BASE_URL}/web/github/status`, () =>
    HttpResponse.json({ enabled: true, connected: true, installations: [], reason: 'ready' }),
  ),
  http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [controlRepository] })),
];

function repositoryEnvironment() {
  return environmentPayload({
    repositories: [environmentRepository({ projectRepositoryId: 'repo-1', slug: PRIMARY_PROJECT })],
  });
}

function renderRepositoriesSettings() {
  return renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/repositories`]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/repositories" element={<RepositoriesSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Repositories settings', () => {
  beforeEach(() => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [{ id: FACTORY_ID, name: 'factory-primary', repositories: [primaryRepository] }],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
        HttpResponse.json({ environment: repositoryEnvironment() }),
      ),
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
  });

  it('keeps the drawer open through linking and a failed attempt, then refreshes the list after retry', async () => {
    const user = userEvent.setup();
    let releaseSave!: () => void;
    const savePending = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    let linked = false;
    let attempts = 0;
    const repository = {
      id: 'repo-2',
      branch: 'main',
      sandboxWorkdir: '~/widget',
      repository: { externalId: '42', slug: 'acme/widget', defaultBranch: 'main' },
    };
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: true, installations: [], reason: 'ready' }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () =>
        HttpResponse.json({
          repos: [
            {
              id: 42,
              fullName: 'acme/widget',
              name: 'widget',
              owner: 'acme',
              defaultBranch: 'main',
              private: true,
              installationId: 1,
              installationStorageId: 'inst-1',
              sandboxProvider: 'custom',
              sandboxWorkdir: '~/widget',
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: FACTORY_ID,
              name: 'factory-primary',
              repositories: linked
                ? [
                    listedRepository('repo-2', 'acme/widget', {
                      externalId: '42',
                      branch: 'main',
                      sandboxWorkdir: '~/widget',
                    }),
                  ]
                : [],
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/source-control-connections`, () =>
        HttpResponse.json({
          connections: [{ id: 'conn-1', integrationId: 'github', installationId: 'inst-1', repositories: [] }],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
        HttpResponse.json({
          environment: environmentPayload({
            repositories: linked
              ? [environmentRepository({ projectRepositoryId: repository.id, slug: repository.repository.slug })]
              : [],
          }),
        }),
      ),
      http.post(
        `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/source-control-connections/conn-1/repositories`,
        async () => {
          await savePending;
          attempts++;
          if (attempts === 1) return HttpResponse.json({ error: 'Link unavailable' }, { status: 503 });
          linked = true;
          return HttpResponse.json({ projectRepository: repository });
        },
      ),
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({ config: { github: { enabled: true, sourceIds: ['acme/widget'] } } }),
      ),
    );

    renderRepositoriesSettings();
    await user.click(await screen.findByRole('button', { name: 'Add repository' }));
    await user.click(await screen.findByRole('button', { name: 'Add acme/widget' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('searchbox', { name: 'Search repositories' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Add repository' })).toBeInTheDocument();

    releaseSave();
    expect(await screen.findByText('Failed to link GitHub repository (503)')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add repository' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Add acme/widget' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add repository' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Remove acme/widget' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add repository' })).toHaveFocus());
  });

  it('does not mistake an unsettled GitHub search or a failed request for an empty result', async () => {
    const user = userEvent.setup();
    let releaseSearch!: () => void;
    const searchPending = new Promise<void>(resolve => {
      releaseSearch = resolve;
    });
    const requests: string[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: true, installations: [], reason: 'ready' }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/repos`, async ({ request }) => {
        const query = new URL(request.url).searchParams.get('q') ?? '';
        requests.push(query);
        if (!query) return HttpResponse.json({ repos: [controlRepository] });
        await searchPending;
        return HttpResponse.json({ error: 'Repository search unavailable' }, { status: 503 });
      }),
    );

    renderRepositoriesSettings();
    await user.click(await screen.findByRole('button', { name: 'Add repository' }));
    expect(await screen.findByRole('button', { name: /Add .*factory-control/ })).toBeInTheDocument();
    vi.useFakeTimers();
    try {
      const search = screen.getByRole('searchbox', { name: 'Search repositories' });
      fireEvent.change(search, { target: { value: 'r' } });
      fireEvent.change(search, { target: { value: 'rem' } });
      fireEvent.change(search, { target: { value: 'remote' } });
      expect(requests).toEqual(['']);
      expect(screen.getByRole('status', { name: 'Loading available repositories' })).toBeInTheDocument();
      expect(screen.queryByText(/No repositories match/)).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(requests).toEqual(['', 'remote']));
    expect(screen.getByRole('status', { name: 'Loading available repositories' })).toBeInTheDocument();
    releaseSearch();
    expect(await screen.findByText(/Failed to list repos/)).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading available repositories' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No repositories match/)).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search repositories' }));
    expect(screen.getByRole('button', { name: /Add .*factory-control/ })).toBeInTheDocument();
    expect(screen.queryByText(/Failed to list repos/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading available repositories' })).not.toBeInTheDocument();
  });

  it('excludes a checkout without unlinking it, then removes only the requested repository with safe retry', async () => {
    const user = userEvent.setup();
    let linked = true;
    let environment = repositoryEnvironment();
    environment.repositories.push(
      environmentRepository({ projectRepositoryId: 'repo-2', slug: 'acme/other', position: 2 }),
    );
    const patches: unknown[] = [];
    let releaseRemoval!: () => void;
    const removalPending = new Promise<void>(resolve => {
      releaseRemoval = resolve;
    });
    let removals = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
        HttpResponse.json({ environment }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: FACTORY_ID,
              name: 'factory-primary',
              repositories: [
                ...(linked ? [listedRepository('repo-1', PRIMARY_PROJECT, { branch: 'main' })] : []),
                listedRepository('repo-2', 'acme/other', { branch: 'main' }),
              ],
            },
          ],
        }),
      ),
      http.patch(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, async ({ request }) => {
        patches.push(await request.json());
        environment = {
          ...environment,
          repositories: environment.repositories.map(repository =>
            repository.projectRepositoryId === 'repo-1' ? { ...repository, inEnvironment: false } : repository,
          ),
        };
        return HttpResponse.json({ environment });
      }),
      http.delete(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/repositories/repo-1`, async () => {
        removals++;
        if (removals === 1) {
          await removalPending;
          return HttpResponse.json({ error: 'Removal unavailable' }, { status: 503 });
        }
        linked = false;
        environment = {
          ...environment,
          repositories: environment.repositories.filter(repo => repo.projectRepositoryId !== 'repo-1'),
        };
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderRepositoriesSettings();
    await user.click(await screen.findByRole('button', { name: `Show settings for ${PRIMARY_PROJECT}` }));
    const clone = screen.getByRole('switch', { name: `Clone ${PRIMARY_PROJECT} into every session` });
    await user.click(clone);
    await waitFor(() => expect(clone).not.toBeChecked());
    expect(screen.getByRole('button', { name: `Hide settings for ${PRIMARY_PROJECT}` })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(patches).toEqual([{ repositories: [{ projectRepositoryId: 'repo-1', inEnvironment: false }] }]);
    expect(removals).toBe(0);
    expect(screen.getByRole('button', { name: `Remove ${PRIMARY_PROJECT}` })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: `Remove ${PRIMARY_PROJECT}` })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Show settings for acme/other' }));
    await user.click(screen.getByRole('button', { name: `Remove ${PRIMARY_PROJECT}` }));
    expect(await screen.findByText('Removing…')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Clone acme/other into every session' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeDisabled();
    releaseRemoval();
    const primaryRow = screen.getByRole('group', { name: PRIMARY_PROJECT });
    expect(await within(primaryRow).findByText('Failed to unlink repository (503)')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'acme/other' })).queryByText(/Failed to unlink/),
    ).not.toBeInTheDocument();
    expect(clone).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: `Remove ${PRIMARY_PROJECT}` }));
    await waitFor(() => expect(screen.queryByText(PRIMARY_PROJECT)).not.toBeInTheDocument());
    expect(screen.getByText('acme/other')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add repository' })).toHaveFocus());
  });

  it('keeps the repositories on screen when refreshing the Factory list fails after a removal', async () => {
    const user = userEvent.setup();
    let environment = repositoryEnvironment();
    environment.repositories.push(
      environmentRepository({ projectRepositoryId: 'repo-2', slug: 'acme/other', position: 2 }),
    );
    let factoryRequests = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => {
        factoryRequests++;
        return factoryRequests === 1
          ? HttpResponse.json({
              projects: [{ id: FACTORY_ID, name: 'factory-primary', repositories: [primaryRepository] }],
            })
          : HttpResponse.json({ error: 'Factories unavailable' }, { status: 503 });
      }),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
        HttpResponse.json({ environment }),
      ),
      http.delete(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/repositories/repo-1`, () => {
        environment = {
          ...environment,
          repositories: environment.repositories.filter(repo => repo.projectRepositoryId !== 'repo-1'),
        };
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderRepositoriesSettings();
    await user.click(await screen.findByRole('button', { name: `Remove ${PRIMARY_PROJECT}` }));

    await waitFor(() => expect(factoryRequests).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add repository' })).toHaveFocus());
    expect(screen.queryByText(/Failed to list Factories/)).not.toBeInTheDocument();
    expect(screen.queryByText(PRIMARY_PROJECT)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'acme/other' })).toBeInTheDocument();
  });

  it('allows adding the first repository while configuration loads, and retries configuration failures without inventing rows', async () => {
    const user = userEvent.setup();
    let releaseEnvironment!: () => void;
    const environmentPending = new Promise<void>(resolve => {
      releaseEnvironment = resolve;
    });
    let fail = true;
    server.use(
      ...githubListingControl(),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'factory-primary', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, async () => {
        await environmentPending;
        return fail
          ? HttpResponse.json({ error: 'Repository configuration unavailable' }, { status: 503 })
          : HttpResponse.json({ environment: environmentPayload({ repositories: [] }) });
      }),
    );

    renderRepositoriesSettings();
    expect(await screen.findByRole('status', { name: 'Loading repository configuration' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(await screen.findByRole('button', { name: /Add .*factory-control/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    releaseEnvironment();
    expect(await screen.findByText(/Failed to load environment/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeEnabled();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry repository configuration' }));
    await waitFor(() => expect(screen.queryByText(/Failed to load environment/)).not.toBeInTheDocument());
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeEnabled();
  });

  it('keeps linked repositories visible while repository discovery loads in the drawer', async () => {
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>(resolve => (releaseStatus = resolve));
    let releaseRepos!: () => void;
    const reposGate = new Promise<void>(resolve => (releaseRepos = resolve));
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: FACTORY_ID,
              name: 'personal-factory',
              repositories: [listedRepository('repo-1', 'octo/agent', { branch: 'main', sandboxWorkdir: '~/agent' })],
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
        HttpResponse.json({
          environment: environmentPayload({
            repositories: [environmentRepository({ projectRepositoryId: 'repo-1', slug: 'octo/agent' })],
          }),
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/status`, async () => {
        await statusGate;
        return HttpResponse.json({ enabled: true, connected: true, reason: 'ready', installations: [] });
      }),
      http.get(`${TEST_BASE_URL}/web/github/pat`, () =>
        HttpResponse.json({ configured: false, reviewerConfigured: false }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/repos`, async () => {
        await reposGate;
        return HttpResponse.json({
          repos: [
            {
              id: 99,
              fullName: 'octo/hello',
              name: 'hello',
              owner: 'octo',
              defaultBranch: 'main',
              private: false,
              installationId: 7,
              installationStorageId: 'inst-7',
              sandboxProvider: 'none',
              sandboxWorkdir: '~/hello',
            },
          ],
        });
      }),
    );

    renderRepositoriesSettings();

    const linkedRepository = await screen.findByText('octo/agent');
    await userEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Add repository' }));
    expect(drawer.getByRole('status', { name: 'Loading available repositories' })).toBeInTheDocument();
    expect(linkedRepository).toBeInTheDocument();

    releaseStatus();
    expect(await drawer.findByRole('button', { name: 'Refresh GitHub repositories' })).toBeInTheDocument();
    expect(drawer.getByRole('status', { name: 'Loading available repositories' })).toBeInTheDocument();

    releaseRepos();
    expect(await drawer.findByText('octo/hello')).toBeInTheDocument();
    expect(drawer.queryByRole('status', { name: 'Loading available repositories' })).not.toBeInTheDocument();
    expect(linkedRepository).toBeInTheDocument();
  });

  it('names the missing GitHub App env vars when no provider can list repositories', async () => {
    const user = userEvent.setup();

    renderRepositoriesSettings();

    expect(await screen.findByRole('link', { name: 'Manage Factory' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/factory`,
    );
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(
      await screen.findByText('GitHub is disabled on the server. Missing env vars: GITHUB_APP_ID.'),
    ).toBeInTheDocument();
  });

  it('shows GitHub CLI tokens only once GitHub matters, and keeps a failed token draft for retry', async () => {
    let configured = false;
    let rejectSave = true;
    const saved: unknown[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/pat`, () => HttpResponse.json({ configured, reviewerConfigured: false })),
      http.post(`${TEST_BASE_URL}/web/github/pat`, async ({ request }) => {
        saved.push(await request.json());
        if (rejectSave) return HttpResponse.json({ error: 'Token rejected' }, { status: 400 });
        configured = true;
        return HttpResponse.json({ ok: true });
      }),
      http.delete(`${TEST_BASE_URL}/web/github/pat`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('kind')).toBe('default');
        configured = false;
        return HttpResponse.json({ ok: true });
      }),
    );
    // No repository linked and GitHub not connected: the tokens have nothing to act on.
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'factory-primary', repositories: [] }] }),
      ),
    );
    const { unmount } = renderRepositoriesSettings();
    expect(await screen.findByRole('link', { name: 'Manage Factory' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'GitHub CLI tokens' })).not.toBeInTheDocument();
    unmount();

    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: true,
          connected: true,
          installations: [{ installationId: 7, accountLogin: 'acme', accountType: 'Organization' }],
          reason: 'ready',
        }),
      ),
    );
    renderRepositoriesSettings();
    const tokens = await screen.findByRole('region', { name: 'GitHub CLI tokens' });
    const workerRow = (await within(tokens).findByText('Worker token')).closest<HTMLElement>(
      '[data-slot="settings-row"]',
    );
    if (!workerRow) throw new Error('Worker token row is missing');
    expect(within(workerRow).getByText('Not set')).toBeInTheDocument();
    await userEvent.click(within(workerRow).getByRole('button', { name: 'Add token' }));
    const input = screen.getByLabelText('Worker token GitHub Personal Access Token');
    await userEvent.type(input, 'worker-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Token rejected')).toBeInTheDocument();
    expect(input).toHaveValue('worker-secret');
    rejectSave = false;
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const updateToken = await screen.findByRole('button', { name: 'Update token' });
    expect(within(tokens).getByText('Configured')).toBeInTheDocument();
    await waitFor(() => expect(updateToken).toHaveFocus());
    expect(saved).toEqual([
      { token: 'worker-secret', kind: 'default' },
      { token: 'worker-secret', kind: 'default' },
    ]);
    await userEvent.click(within(tokens).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(tokens).getAllByRole('button', { name: 'Add token' })).toHaveLength(2));
  });
});
