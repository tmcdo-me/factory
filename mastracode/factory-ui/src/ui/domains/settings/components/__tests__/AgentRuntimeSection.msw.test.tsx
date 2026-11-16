// fork(claude-agent)
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { AgentRuntimeSection } from '../AgentRuntimeSection';

const FACTORY_ID = 'factory-1';
const PROJECT_RUNTIME = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/runtime`;

describe('Agent runtime settings', () => {
  it("shows the Factory's default runtime and saves a new one", async () => {
    let saved: unknown;
    let runtimeId = 'mastra-code';
    server.use(
      http.get(PROJECT_RUNTIME, () => HttpResponse.json({ runtimeId })),
      http.put(PROJECT_RUNTIME, async ({ request }) => {
        saved = await request.json();
        runtimeId = (saved as { runtimeId: string }).runtimeId;
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AgentRuntimeSection factoryId={FACTORY_ID} />);

    const picker = await screen.findByRole('combobox', { name: 'Default agent runtime' });
    expect(picker).toHaveTextContent('Mastra Code');

    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Claude Agent' }));

    await waitFor(() => expect(saved).toEqual({ runtimeId: 'claude-agent' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default agent runtime' })).toHaveTextContent('Claude Agent'),
    );
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });

  it('says when the runtimes could not be loaded', async () => {
    server.use(http.get(PROJECT_RUNTIME, () => HttpResponse.json({ error: 'Project not found' }, { status: 404 })));
    renderWithProviders(<AgentRuntimeSection factoryId={FACTORY_ID} />);

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });
});
