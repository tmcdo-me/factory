// fork(claude-agent): a session is one conversation; its tab title is the session's own name.
import { SidebarProvider } from '@mastra/playground-ui/components/Sidebar';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { OverlaysProvider } from '../../../../lib/overlays';
import { ChatSessionTestProvider } from '../../context/ChatSessionTestProvider';
import { useChatTranscript } from '../../context/useChatTranscript';
import { PageTitle } from '../PageTitle';
import { FACTORY_ID, PROJECT_REPOSITORY_ID, SESSION_ID, stubPreparingSession } from './composer-session-test-fixture';

function RunProbe() {
  return <output aria-label="Run">{useChatTranscript().busy ? 'running' : 'idle'}</output>;
}

afterEach(() => {
  document.title = 'Mastra Factory';
});

describe('the tab title of a session', () => {
  it('picks up the name the server gives the session during its first run, once the run ends', async () => {
    const session = stubPreparingSession({ autoAgentEnd: false, materialized: true });
    // The server writes the name the agent gave the conversation onto the session row.
    let named = false;
    server.use(
      http.get(`${TEST_BASE_URL}/web/user-sessions/:sessionId`, () =>
        HttpResponse.json({
          session: {
            id: 'row-1',
            sessionId: SESSION_ID,
            projectRepositoryId: PROJECT_REPOSITORY_ID,
            orgId: 'org-1',
            userId: 'user-1',
            ...(named ? { title: 'Fix the login bug' } : {}),
            branch: 'user/session-1',
            baseBranch: 'main',
            sandboxId: null,
            sandboxWorkdir: null,
            materializedAt: '2026-07-23T00:00:00.000Z',
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
        }),
      ),
    );
    renderWithProviders(
      <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/user/threads/${SESSION_ID}`]}>
        <Routes>
          <Route
            path="/factories/:factoryId/user/threads/:threadId"
            element={
              <SidebarProvider storageKey="page-title-test">
                <ChatSessionTestProvider threadId={SESSION_ID} userScoped deferUntilMessagesReady={false}>
                  <OverlaysProvider>
                    <PageTitle />
                    <RunProbe />
                  </OverlaysProvider>
                </ChatSessionTestProvider>
              </SidebarProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    session.finishWorkspace();

    // Once the session's live state is read, a run shows as running.
    await waitFor(async () => {
      await session.emit({ type: 'agent_start' });
      expect(screen.getByRole('status', { name: 'Run' })).toHaveTextContent('running');
    });
    named = true;
    expect(document.title).toBe('Mastra Factory');
    await session.emit({ type: 'agent_end' });

    await waitFor(() => expect(document.title).toBe('Fix the login bug | Mastra Factory'));
  });

  it('shows the name the agent gives the conversation as soon as it is given, in the tab and the session row', async () => {
    const session = stubPreparingSession({ autoAgentEnd: false, materialized: true });
    const { client } = renderWithProviders(
      <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/user/threads/${SESSION_ID}`]}>
        <Routes>
          <Route
            path="/factories/:factoryId/user/threads/:threadId"
            element={
              <SidebarProvider storageKey="page-title-test">
                <ChatSessionTestProvider threadId={SESSION_ID} userScoped deferUntilMessagesReady={false}>
                  <OverlaysProvider>
                    <PageTitle />
                  </OverlaysProvider>
                </ChatSessionTestProvider>
              </SidebarProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    session.finishWorkspace();

    // Another thread's title is not this session's.
    await session.emit({ type: 'thread_title_updated', threadId: 'other-thread', title: 'Not this one' });
    await session.emit({ type: 'thread_title_updated', threadId: SESSION_ID, title: '  Fix   the login bug ' });

    await waitFor(() => expect(document.title).toBe('Fix the login bug | Mastra Factory'));
    expect(client.getQueryData<{ title?: string }>(['user-session', SESSION_ID])?.title).toBe('Fix the login bug');
  });
});
