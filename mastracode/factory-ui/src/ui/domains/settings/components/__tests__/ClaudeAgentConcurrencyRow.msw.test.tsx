// fork(claude-agent): spec slice 13.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { AgentRuntimeSection } from '../AgentRuntimeSection';

const CONCURRENCY = `${TEST_BASE_URL}/web/factory/runtimes/claude-agent/concurrency`;

describe('Claude Agent concurrency setting', () => {
  it("shows the server's default and saves a limit when the field is left", async () => {
    const saved: unknown[] = [];
    let state = { maxConcurrent: null as number | null, defaultMaxConcurrent: 2, effective: 2, running: 2, waiting: 1 };
    server.use(
      http.get(CONCURRENCY, () => HttpResponse.json(state)),
      http.put(CONCURRENCY, async ({ request }) => {
        const body = (await request.json()) as { maxConcurrent: number | null };
        saved.push(body);
        state = { ...state, maxConcurrent: body.maxConcurrent, effective: body.maxConcurrent ?? 2, waiting: 0 };
        return HttpResponse.json(state);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AgentRuntimeSection factoryId="factory-1" />);

    const field = await screen.findByRole('textbox', { name: 'Runs at once' });
    await waitFor(() => expect(field).toBeEnabled());
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', '2');
    expect(screen.getByText(/2 \(FACTORY_CLAUDE_AGENT_MAX_CONCURRENT\)/)).toBeInTheDocument();
    expect(screen.getByText(/Now: 2 running, 1 waiting\./)).toBeInTheDocument();

    await user.type(field, '3');
    await user.tab();
    await waitFor(() => expect(saved).toEqual([{ maxConcurrent: 3 }]));
    await waitFor(() => expect(screen.getByText(/Now: 2 running\./)).toBeInTheDocument());

    // Emptied: back to the server's default.
    await user.clear(screen.getByRole('textbox', { name: 'Runs at once' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(saved).toEqual([{ maxConcurrent: 3 }, { maxConcurrent: null }]));
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });

  it('refuses a limit that is not a whole number, without saving it', async () => {
    let puts = 0;
    server.use(
      http.put(CONCURRENCY, () => {
        puts += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AgentRuntimeSection factoryId="factory-1" />);
    const field = await screen.findByRole('textbox', { name: 'Runs at once' });
    await waitFor(() => expect(field).toBeEnabled());
    await user.type(field, '1.5');
    await user.tab();
    expect(await screen.findByText('A whole number from 0 to 64, or empty.')).toBeInTheDocument();
    expect(puts).toBe(0);
  });
});
