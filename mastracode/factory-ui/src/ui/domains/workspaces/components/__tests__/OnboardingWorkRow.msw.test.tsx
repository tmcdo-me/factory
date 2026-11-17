import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { OnboardingWorkRow } from '../onboarding/OnboardingWorkRow';
import type { OnboardingWorkRowProps } from '../onboarding/OnboardingWorkRow';
import type { GithubRepo } from '../../services/github';

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

function renderRow(overrides: Partial<OnboardingWorkRowProps> = {}) {
  return renderWithProviders(
    <OnboardingWorkRow confirmed={false} onChange={() => {}} changeDisabled={false} {...overrides} />,
  );
}

describe('OnboardingWorkRow', () => {
  it('names the codebase host as the source Work can bring in', () => {
    renderRow();

    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('summarizes GitHub as the source once Work is finished', async () => {
    renderRow({ confirmed: true, repository: githubRepository });

    expect(await screen.findByText('GitHub')).toBeInTheDocument();
  });

  it('says nothing was set up once the Work step switched the repository off', async () => {
    renderRow({ confirmed: true, repository: githubRepository, codeHostSync: false });

    expect(await screen.findByText('Set up later')).toBeInTheDocument();
  });
});
