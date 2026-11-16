import { SidebarProvider } from '@mastra/playground-ui/components/Sidebar';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { OverlaysProvider } from '../../../../lib/overlays';
import { QueuedFollowUps } from '../../components/StatusLine/QueuedFollowUps';
import { Transcript } from '../../components/Transcript';
import { FACTORY_ID, SESSION_ID, stubPreparingSession } from '../../components/__tests__/composer-session-test-fixture';
import type { SessionStateSnapshot } from '../../services/runtime';
import { useChatCommands } from '../ChatCommandsProvider';
import { ChatSessionTestProvider } from '../ChatSessionTestProvider';
import { useChatTranscript } from '../useChatTranscript';

const snapshot: SessionStateSnapshot = {
  threadId: SESSION_ID,
  tokenUsage: { promptTokens: 21, completionTokens: 34, totalTokens: 55 },
};

function RuntimeSurface({ resetState }: { resetState?: SessionStateSnapshot }) {
  const { reset } = useChatTranscript();
  const { runComposerCommand } = useChatCommands();
  return (
    <>
      <QueuedFollowUps />
      <Transcript />
      <button onClick={() => void runComposerCommand('/cost')}>Cost</button>
      <button onClick={() => reset('next-thread', resetState)}>Reset thread</button>
    </>
  );
}

function renderRuntime(resetState?: SessionStateSnapshot) {
  const session = stubPreparingSession();
  server.use(
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:resourceId`, ({ params }) =>
      HttpResponse.json({ controllerId: 'code', resourceId: params.resourceId, ...snapshot }),
    ),
  );
  renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/user/threads/${SESSION_ID}`]}>
      <Routes>
        <Route
          path="/factories/:factoryId/user/threads/:threadId"
          element={
            <SidebarProvider storageKey="runtime-test">
              <ChatSessionTestProvider threadId={SESSION_ID} userScoped deferUntilMessagesReady={false}>
                <OverlaysProvider>
                  <RuntimeSurface resetState={resetState} />
                </OverlaysProvider>
              </ChatSessionTestProvider>
            </SidebarProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  session.finishWorkspace();
  return session;
}

describe('chat runtime consumers', () => {
  it('hydrates status from the session and updates the status line and commands from live events', async () => {
    const session = renderRuntime();
    const user = userEvent.setup();
    // The session's state snapshot carries the usage so far; the cost reads it once it lands.
    await waitFor(async () => {
      await user.click(screen.getByRole('button', { name: 'Cost' }));
      expect(screen.getAllByText('Used 55 tokens (21 prompt, 34 completion).').length).toBeGreaterThan(0);
    });

    await session.emit({
      type: 'display_state_changed',
      displayState: { tokenUsage: { promptTokens: 30, completionTokens: 45, totalTokens: 75 } },
    });
    await session.emit({ type: 'follow_up_queued', count: 2 });

    expect(await screen.findByText('2 queued')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cost' }));
    expect(await screen.findByText('Used 75 tokens (30 prompt, 45 completion).')).toBeInTheDocument();
  });

  it.each([
    { scenario: 'no snapshot', resetState: undefined, restoreSnapshot: false },
    { scenario: 'matching thread', resetState: { ...snapshot, threadId: 'next-thread' }, restoreSnapshot: true },
    { scenario: 'another thread', resetState: snapshot, restoreSnapshot: false },
    { scenario: 'missing thread ID', resetState: { ...snapshot, threadId: undefined }, restoreSnapshot: false },
  ])('resets transcript and runtime together with $scenario', async ({ resetState, restoreSnapshot }) => {
    const session = renderRuntime(resetState);
    const user = userEvent.setup();
    await session.emit({ type: 'follow_up_queued', count: 2 });
    await session.emit({ type: 'display_state_changed', displayState: snapshot });
    await session.emit({ type: 'info', message: 'Previous thread notice' });
    await screen.findByText('Previous thread notice');
    await user.click(screen.getByRole('button', { name: 'Reset thread' }));

    await waitFor(() => expect(screen.queryByText('Previous thread notice')).not.toBeInTheDocument());
    expect(screen.queryByText('2 queued')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cost' }));
    expect(
      await screen.findByText(
        restoreSnapshot ? 'Used 55 tokens (21 prompt, 34 completion).' : 'No token usage recorded yet.',
      ),
    ).toBeInTheDocument();
  });
});
