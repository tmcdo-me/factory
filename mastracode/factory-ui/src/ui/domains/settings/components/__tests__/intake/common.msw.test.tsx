import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../../../../e2e/ui/msw-server';
import type { GithubStatus } from '../../../../workspaces/services/github';
import {
  CONFIG_URL,
  BINDINGS_URL,
  GITHUB_STATUS_URL,
  baseConfig,
  githubReadyStatus,
  seedGithubProject,
  seedGithubProjectWithTwoRepositories,
  useIntakeHandlers,
  renderIntakeSection,
  openSourcePicker,
  closeSourcePicker,
  holdFirstPut,
} from './fixtures';

describe('IntakeSection common', () => {
  describe('given a config with the default sources enabled', () => {
    it('keeps source pickers closed until requested', async () => {
      seedGithubProject();
      useIntakeHandlers();

      renderIntakeSection();

      expect(await screen.findByRole('switch', { name: 'Sync GitHub issues' })).toBeChecked();
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const connectedSources = screen.getByRole('region', { name: 'Connected sources' });
      expect(within(connectedSources).getByRole('region', { name: 'GitHub' })).toBeInTheDocument();
      await openSourcePicker('Repositories');
      expect(await screen.findByRole('button', { name: 'Add mastra' })).toBeInTheDocument();
    });

    it('focuses drawer search and returns to the add action on Escape', async () => {
      seedGithubProject();
      useIntakeHandlers();
      renderIntakeSection();
      const trigger = await screen.findByRole('button', { name: 'Add repository to Repositories' });
      await userEvent.click(trigger);
      await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search Repositories' })).toHaveFocus());
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('searchbox', { name: 'Search Repositories' })).toBeInTheDocument();
    });
  });

  describe('when the GitHub source is toggled off', () => {
    it('sends only the GitHub selection when GitHub is toggled off', async () => {
      seedGithubProject();
      const custom = { enabled: false, sourceIds: ['src-1'] };
      const saved = useIntakeHandlers({ config: { ...baseConfig(), 'custom-tracker': custom } });

      renderIntakeSection();

      await userEvent.click(await screen.findByRole('switch', { name: 'Sync GitHub issues' }));

      await waitFor(() => expect(saved).toEqual([{ github: { enabled: false, sourceIds: null } }]));
    });
  });

  describe('given the source status is still loading', () => {
    it('waits before classifying an unconnected source', async () => {
      useIntakeHandlers();
      let releaseStatus!: () => void;
      const pendingStatus = new Promise<void>(resolve => {
        releaseStatus = resolve;
      });
      let requested = false;
      server.use(
        http.get(GITHUB_STATUS_URL, async () => {
          requested = true;
          await pendingStatus;
          return HttpResponse.json({
            enabled: true,
            connected: false,
            installations: [],
            reason: 'ready',
          } satisfies GithubStatus);
        }),
      );

      renderIntakeSection();

      await waitFor(() => expect(requested).toBe(true));
      expect(screen.getByRole('status', { name: 'Loading intake sources' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Connected sources' })).not.toBeInTheDocument();

      releaseStatus();

      const connect = await screen.findByRole('button', { name: 'Connect GitHub' });
      expect(screen.getByRole('region', { name: 'Add a source' })).toContainElement(connect);
      expect(screen.queryByRole('region', { name: 'Connected sources' })).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Sync GitHub issues' })).not.toBeInTheDocument();
    });
  });

  describe('when a repository is picked', () => {
    it('shows a picked source as added at once and keeps the drawer usable while it saves', async () => {
      seedGithubProjectWithTwoRepositories();
      const saved = useIntakeHandlers();
      const release = holdFirstPut(CONFIG_URL);
      renderIntakeSection();
      await openSourcePicker('Repositories');

      await userEvent.click(await screen.findByRole('button', { name: 'Add mastra' }));

      const drawer = screen.getByRole('dialog', { name: 'Add repository' });
      const added = await within(drawer).findByRole('region', { name: 'Added' });
      expect(within(added).getByRole('button', { name: 'Remove mastra' })).toBeInTheDocument();
      expect(screen.getByRole('status', { name: 'Saving Repositories selection' })).toBeInTheDocument();
      expect(within(drawer).getByRole('button', { name: 'Add docs' })).toBeEnabled();

      await closeSourcePicker();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Remove mastra' })).toBeInTheDocument();
      expect(screen.getByRole('status', { name: 'Saving Repositories selection' })).toBeInTheDocument();

      release();

      await waitFor(() =>
        expect(screen.queryByRole('status', { name: 'Saving Repositories selection' })).not.toBeInTheDocument(),
      );
      expect(await screen.findByText('Intake sources updated')).toBeInTheDocument();
      expect(saved).toEqual([{ github: { enabled: true, sourceIds: ['mastra'] } }]);
    });

    it('keeps every pick made while an earlier save is in flight, in click order', async () => {
      seedGithubProjectWithTwoRepositories();
      const saved = useIntakeHandlers();
      const release = holdFirstPut(CONFIG_URL);
      renderIntakeSection();
      await openSourcePicker('Repositories');

      await userEvent.click(await screen.findByRole('button', { name: 'Add mastra' }));
      await userEvent.click(screen.getByRole('button', { name: 'Add docs' }));

      const added = within(screen.getByRole('dialog', { name: 'Add repository' })).getByRole('region', {
        name: 'Added',
      });
      expect(within(added).getByRole('button', { name: 'Remove mastra' })).toBeInTheDocument();
      expect(within(added).getByRole('button', { name: 'Remove docs' })).toBeInTheDocument();

      release();

      await waitFor(() =>
        expect(saved).toEqual([
          { github: { enabled: true, sourceIds: ['mastra'] } },
          { github: { enabled: true, sourceIds: ['mastra', 'docs'] } },
        ]),
      );
      await closeSourcePicker();
      expect(await screen.findByRole('button', { name: 'Remove mastra' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove docs' })).toBeInTheDocument();
    });

    it('takes a refused pick back and says why', async () => {
      seedGithubProject();
      useIntakeHandlers();
      server.use(http.put(CONFIG_URL, () => HttpResponse.json({ error: 'storage_unavailable' }, { status: 500 })));
      renderIntakeSection();
      await openSourcePicker('Repositories');

      await userEvent.click(await screen.findByRole('button', { name: 'Add mastra' }));

      expect(await screen.findByText('storage_unavailable')).toBeInTheDocument();
      const drawer = screen.getByRole('dialog', { name: 'Add repository' });
      expect(await within(drawer).findByRole('button', { name: 'Add mastra' })).toBeInTheDocument();
      expect(within(drawer).queryByRole('region', { name: 'Added' })).not.toBeInTheDocument();
    });

    it('lets a refused pick be retried in the open drawer after the reload fails too', async () => {
      seedGithubProject();
      const saved = useIntakeHandlers();
      renderIntakeSection();
      await openSourcePicker('Repositories');
      let down = true;
      let reloadFailed = false;
      server.use(
        http.put(CONFIG_URL, () => (down ? HttpResponse.json({ error: 'bad_gateway' }, { status: 502 }) : undefined)),
        http.get(CONFIG_URL, () => {
          if (!down) return;
          reloadFailed = true;
          return HttpResponse.json({ error: 'unavailable' }, { status: 500 });
        }),
      );

      await userEvent.click(await screen.findByRole('button', { name: 'Add mastra' }));
      expect(await screen.findByText('bad_gateway')).toBeInTheDocument();
      await waitFor(() => expect(reloadFailed).toBe(true));
      down = false;

      const drawer = screen.getByRole('dialog', { name: 'Add repository' });
      await userEvent.click(within(drawer).getByRole('button', { name: 'Add mastra' }));

      const added = await within(drawer).findByRole('region', { name: 'Added' });
      expect(within(added).getByRole('button', { name: 'Remove mastra' })).toBeInTheDocument();
      await waitFor(() => expect(saved).toEqual([{ github: { enabled: true, sourceIds: ['mastra'] } }]));
    });
  });

  describe('given the server omits unregistered integrations', () => {
    it('renders the GitHub source with default toggles instead of crashing', async () => {
      seedGithubProject();
      server.use(
        http.get(CONFIG_URL, () => HttpResponse.json({ config: {} })),
        http.get(GITHUB_STATUS_URL, () =>
          HttpResponse.json({ enabled: false, connected: false, installations: [], reason: 'missing_config' }),
        ),
      );

      renderIntakeSection();

      expect(await screen.findByText('GitHub is not configured on this server.')).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Sync GitHub issues' })).not.toBeInTheDocument();
    });
  });

  describe('given the config endpoint fails', () => {
    it('shows the unavailable notice', async () => {
      server.use(
        http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: [] })),
        http.get(CONFIG_URL, () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
        http.get(GITHUB_STATUS_URL, () => HttpResponse.json(githubReadyStatus)),
      );

      renderIntakeSection();

      expect(await screen.findByText(/Intake configuration is unavailable/)).toBeInTheDocument();
    });
  });

  describe('given the source status endpoint fails', () => {
    it('keeps an unknown GitHub connection out of the connected and available source lists', async () => {
      useIntakeHandlers();
      server.use(http.get(GITHUB_STATUS_URL, () => HttpResponse.json({ error: 'unavailable' }, { status: 500 })));
      renderIntakeSection();
      const unavailableSources = await screen.findByRole('region', { name: 'Unavailable sources' });
      expect(within(unavailableSources).getByRole('region', { name: 'GitHub' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Connected sources' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Connect GitHub' })).not.toBeInTheDocument();
      expect(within(unavailableSources).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
  });

  describe('given no source is connected', () => {
    it('lists sources to add without an empty connected section', async () => {
      useIntakeHandlers({
        githubStatus: { enabled: true, connected: false, installations: [], reason: 'ready' },
      });

      renderIntakeSection();

      const addSource = await screen.findByRole('region', { name: 'Add a source' });
      expect(within(addSource).getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
      expect(screen.queryByRole('region', { name: 'Connected sources' })).not.toBeInTheDocument();
      expect(screen.queryByText('Connected sources')).not.toBeInTheDocument();
    });
  });
});
