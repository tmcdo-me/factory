import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';

import { listedRepository } from '../../../../../../../e2e/ui/factory-projects';
import { server } from '../../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../../e2e/ui/render';
import type { IntakeConfig, IntakeSelection } from '../../../../factory/services/intake';
import type { GithubStatus } from '../../../../workspaces/services/github';
import { IntakeSection } from '../../IntakeSection';

export const CONFIG_URL = `${TEST_BASE_URL}/web/intake/config`;
export const BINDINGS_URL = `${TEST_BASE_URL}/web/intake/bindings`;
export const GITHUB_STATUS_URL = `${TEST_BASE_URL}/web/github/status`;

export function baseConfig(): IntakeConfig {
  return {
    github: { enabled: true, sourceIds: null },
  };
}

export const githubReadyStatus: GithubStatus = {
  enabled: true,
  connected: true,
  installations: [{ installationId: 1, accountLogin: 'acme', accountType: 'Organization' }],
  reason: 'ready',
};

export function seedGithubProject() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [{ id: 'fp-1', name: 'mastra', repositories: [listedRepository('ghp-1', 'mastra')] }],
      }),
    ),
  );
}

/** A project with two linked repositories, so a picker can take more than one. */
export function seedGithubProjectWithTwoRepositories() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: 'fp-1',
            name: 'mastra',
            repositories: [listedRepository('ghp-1', 'mastra'), listedRepository('ghp-2', 'docs')],
          },
        ],
      }),
    ),
  );
}

export function useIntakeHandlers({
  config = baseConfig(),
  githubStatus = githubReadyStatus,
}: {
  config?: IntakeConfig;
  githubStatus?: GithubStatus;
} = {}) {
  let stored = config;
  const saved: Array<Record<string, IntakeSelection>> = [];
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json({ config: stored })),
    http.put<Record<string, never>, Record<string, IntakeSelection>>(CONFIG_URL, async ({ request }) => {
      const body = await request.json();
      saved.push(body);
      stored = { ...stored, ...body };
      return HttpResponse.json({ config: stored });
    }),
    http.get(GITHUB_STATUS_URL, () => HttpResponse.json(githubStatus)),
    http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings: [] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [] })),
  );
  return saved;
}

export function renderIntakeSection(path = '/factories/fp-1/settings/intake') {
  return renderWithProviders(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/intake" element={<IntakeSection />} />
      </Routes>
      <Toaster position="bottom-right" />
    </MemoryRouter>,
  );
}

export async function openSourcePicker(label: string) {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(` to ${label}$`) }));
}

export async function closeSourcePicker() {
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
}

export function holdFirstPut(url: string) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let held = false;
  server.use(
    http.put(url, async () => {
      if (held) return;
      held = true;
      await gate;
    }),
  );
  return release;
}
