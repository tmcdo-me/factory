import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import type { GithubRepo } from '../../services/github';
import { ProjectManagementFactoryStep } from '../ProjectManagementFactoryStep';
import type { ProjectManagementFactoryStepProps } from '../ProjectManagementFactoryStep';

const githubRepository: GithubRepo = {
  id: 99,
  fullName: 'acme/widgets',
  name: 'widgets',
  owner: 'acme',
  defaultBranch: 'main',
  private: false,
  installationId: 7,
  installationStorageId: 'inst-7',
  sandboxProvider: 'local',
  sandboxWorkdir: '/workspace/widgets',
};

function renderStep(overrides: Partial<ProjectManagementFactoryStepProps> = {}) {
  return renderWithProviders(<ProjectManagementFactoryStep onContinue={() => {}} {...overrides} />);
}

describe('ProjectManagementFactoryStep', () => {
  it('offers to skip before the codebase step picked a repository', async () => {
    renderStep();

    expect(await screen.findByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  describe('given the codebase step picked a repository', () => {
    it('lists the GitHub repository as a source that is on by default', async () => {
      renderStep({ repository: githubRepository });

      expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
      expect(screen.getByText('Sync issues from acme/widgets')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Sync GitHub issues' })).toBeChecked();
      // The repository is a source on its own, so Work has something to bring in and
      // "Skip for now" would be misleading.
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    });

    it('reports the switch being turned off', async () => {
      const onCodeHostSyncChange = vi.fn();
      renderStep({ repository: githubRepository, onCodeHostSyncChange });

      const user = userEvent.setup();
      await user.click(await screen.findByRole('switch', { name: 'Sync GitHub issues' }));

      // The switch reports the new value alongside its change details.
      expect(onCodeHostSyncChange).toHaveBeenCalledWith(false, expect.anything());
    });

    it('offers to skip while the switch is off', async () => {
      renderStep({ repository: githubRepository, codeHostSync: false });

      expect(await screen.findByRole('switch', { name: 'Sync GitHub issues' })).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    });
  });
});
