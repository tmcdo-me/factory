// fork(claude-agent): the waiting page, where a person answers a run's question or plan without opening its session.
import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { pushableFeedStream } from '../../../../e2e/ui/feed-stream';
import { server } from '../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../e2e/ui/render';
import { emptyAttention, waitingItem } from '../../../../e2e/ui/waiting';
import type { WorkspaceFile } from '../../../api/types';
import type { FactoryInboxItem, FactoryProposalItem } from '../../domains/factory/services/waiting';
import { createAppRoutes } from '../../router';

const FACTORY_ID = 'fp-1';
const ATTENTION = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/attention`;

const question = waitingItem({
  sessionId: 'session-asking',
  title: 'Broken login',
  interaction: {
    toolCallId: 'call_question',
    request: {
      kind: 'question',
      question: 'Which branch should this target?',
      options: [{ label: 'main' }, { label: 'release/1.x', description: 'The maintenance line' }],
      selection: 'single',
    },
  },
});

/** A Claude Agent session's plan: the broker read the file, so the plan comes with it. */
const inlinePlan = waitingItem({
  sessionId: 'session-planning',
  title: 'Dark mode',
  toolName: 'submit_plan',
  detail: 'Plan waiting for review',
  interaction: {
    toolCallId: 'toolu_plan',
    interactionId: 'int-1',
    request: {
      kind: 'plan_approval',
      planPath: '.artifacts/plans/dark-mode.md',
      plan: '# Ship dark mode\n\n1. Add the toggle',
    },
  },
});

/** A Mastra Code session's plan: only its path, read from the session's workspace. */
const workspacePlan = waitingItem({
  sessionId: 'session-mastra',
  title: 'Search',
  toolName: 'submit_plan',
  detail: 'Plan waiting for review',
  interaction: {
    toolCallId: 'call_plan',
    request: { kind: 'plan_approval', planPath: '.artifacts/plans/search.md' },
  },
});

/** A Claude Agent run whose turn ended asking in plain text: no tool call asked, only the interaction names it. */
const plainTextQuestion = waitingItem({
  sessionId: 'session-plain',
  title: 'CSV import',
  interaction: {
    interactionId: 'int-plain',
    request: { kind: 'question', question: 'Staging or production?' },
  },
});

/** A move the board held for a person (an auto-fix past its attempts). */
const proposal: FactoryProposalItem = {
  key: 'fp-1:automation-proposed:decision-1:1',
  kind: 'automation-proposed',
  decisionId: 'decision-1',
  decisionType: 'transition',
  occurrence: 1,
  workItemId: 'item-2',
  title: 'Flaky checkout test',
  detail: 'Waiting for approval to move to execute',
  occurredAt: '2026-11-16T12:30:00.000Z',
  read: false,
  archived: false,
  target: { kind: 'work-item', workItemId: 'item-2', board: 'work' },
};

function stubFactory() {
  const feed = pushableFeedStream(FACTORY_ID);
  server.use(
    feed.handler,
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sessions`, () => HttpResponse.json({ sessions: [] })),
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'Acme Factory', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-records`, () =>
      HttpResponse.json({ workRecords: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/subscriptions`, () => HttpResponse.json({ subscriptions: [] })),
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:resourceId/permissions`, () =>
      HttpResponse.json({}),
    ),
  );
  return feed;
}

/** The inbox lists `items` until they are answered; records which kinds and views were asked for. */
function stubWaiting(initial: FactoryInboxItem[]) {
  let items = initial;
  const reads: URLSearchParams[] = [];
  server.use(
    http.get(ATTENTION, ({ request }) => {
      reads.push(new URL(request.url).searchParams);
      return HttpResponse.json({ ...emptyAttention, items });
    }),
  );
  return {
    reads,
    answered: (id: string) => {
      items = items.filter(item => (item.kind === 'agent-waiting' ? item.sessionId : item.decisionId) !== id);
    },
    asks: (item: FactoryInboxItem) => {
      items = [item, ...items];
    },
  };
}

function renderRoute() {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/waiting`] });
  return {
    router,
    ...renderWithProviders(
      <>
        <RouterProvider router={router} />
        <Toaster />
      </>,
    ),
  };
}

describe('WaitingPage', () => {
  it("answers a run's question in place, and the run leaves the list once answered", async () => {
    stubFactory();
    const inbox = stubWaiting([question]);
    const bodies: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/user-sessions/:sessionId/parked-question`, async ({ request, params }) => {
        bodies.push({ sessionId: params.sessionId, body: await request.json() });
        inbox.answered(String(params.sessionId));
        return HttpResponse.json({ answered: true, sessionId: params.sessionId, toolCallId: 'call_question' });
      }),
    );
    const user = userEvent.setup();
    renderRoute();

    const list = await screen.findByRole('list', { name: 'Waiting sessions' });
    expect(within(list).getByText('Broken login')).toBeInTheDocument();
    expect(within(list).getByText('Which branch should this target?')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/workspaces/session-asking/threads/session-asking`,
    );
    // Only sessions still waiting on someone are asked for.
    expect(inbox.reads[0]?.getAll('kind')).toEqual(['agent-waiting', 'automation-proposed']);
    expect(inbox.reads[0]?.get('view')).toBe('open');

    await user.click(within(list).getByRole('radio', { name: /release\/1\.x/ }));

    await waitFor(() =>
      expect(bodies).toEqual([
        { sessionId: 'session-asking', body: { answer: 'release/1.x', toolCallId: 'call_question' } },
      ]),
    );
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  it('answers a question a run asked in plain text, naming it by its interaction', async () => {
    stubFactory();
    const inbox = stubWaiting([plainTextQuestion]);
    const bodies: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/user-sessions/:sessionId/parked-question`, async ({ request, params }) => {
        bodies.push({ sessionId: params.sessionId, body: await request.json() });
        inbox.answered(String(params.sessionId));
        return HttpResponse.json({ answered: true, sessionId: params.sessionId, interactionId: 'int-plain' });
      }),
    );
    const user = userEvent.setup();
    renderRoute();

    expect(await screen.findByText('Staging or production?')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), 'Staging');
    await user.click(screen.getByRole('button', { name: 'Submit answer' }));

    await waitFor(() =>
      expect(bodies).toEqual([{ sessionId: 'session-plain', body: { answer: 'Staging', interactionId: 'int-plain' } }]),
    );
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  it('approves a proposal through the decision route, and shows why when the server holds it for an admin', async () => {
    stubFactory();
    const inbox = stubWaiting([proposal]);
    const actions: string[] = [];
    let held = true;
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/decisions/:decisionId/:action`, ({ params }) => {
        actions.push(`${String(params.decisionId)} ${String(params.action)}`);
        if (held && params.action === 'approve') {
          return HttpResponse.json(
            {
              error: 'decision_held_for_person',
              message:
                'This move waits for a person: an organization administrator approves it on the board or in the inbox.',
            },
            { status: 403 },
          );
        }
        inbox.answered(String(params.decisionId));
        return HttpResponse.json({ decision: { id: params.decisionId, status: 'dismissed' } });
      }),
    );
    const user = userEvent.setup();
    renderRoute();

    const group = await screen.findByRole('group', { name: 'Proposal: Waiting for approval to move to execute' });
    await user.click(within(group).getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText(
        'This move waits for a person: an organization administrator approves it on the board or in the inbox.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Flaky checkout test')).toBeInTheDocument();

    held = false;
    await user.click(within(group).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(actions).toEqual(['decision-1 approve', 'decision-1 dismiss']));
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  it('approves a plan that came with its content, naming the call it answers', async () => {
    stubFactory();
    const inbox = stubWaiting([inlinePlan]);
    const bodies: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/user-sessions/:sessionId/parked-approval`, async ({ request, params }) => {
        bodies.push({ sessionId: params.sessionId, body: await request.json() });
        inbox.answered(String(params.sessionId));
        return HttpResponse.json({ answered: 'approve', sessionId: params.sessionId, toolCallId: 'toolu_plan' });
      }),
    );
    const user = userEvent.setup();
    renderRoute();

    expect(await screen.findByText('Add the toggle')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve the plan and build it' }));

    await waitFor(() =>
      expect(bodies).toEqual([
        { sessionId: 'session-planning', body: { decision: 'approve', toolCallId: 'toolu_plan' } },
      ]),
    );
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  it("reads a plan that came with only its path from that session's workspace", async () => {
    stubFactory();
    stubWaiting([workspacePlan]);
    const reads: URLSearchParams[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/workspace/file`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        reads.push(params);
        const file: WorkspaceFile = {
          workspacePath: params.get('workspacePath') ?? '',
          path: params.get('path') ?? '',
          name: 'search.md',
          size: 30,
          updatedAt: '2026-11-16T12:00:00.000Z',
          contentType: 'text',
          content: '# Search\n\n1. Index the cards',
        };
        return HttpResponse.json(file);
      }),
    );
    renderRoute();

    expect(await screen.findByText('Index the cards')).toBeInTheDocument();
    expect(reads.map(params => [params.get('workspacePath'), params.get('path')])).toEqual([
      ['session-mastra', '.artifacts/plans/search.md'],
    ]);
    expect(screen.getByRole('button', { name: 'Approve the plan and build it' })).toBeEnabled();
  });

  it("says why an answer was refused and keeps the run listed, as when someone else can't answer it", async () => {
    stubFactory();
    stubWaiting([question]);
    server.use(
      http.post(`${TEST_BASE_URL}/web/user-sessions/:sessionId/parked-question`, () =>
        HttpResponse.json(
          { error: "Only the session's owner, an organization admin, or someone following its card can answer." },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute();

    await user.click(await screen.findByRole('radio', { name: /^main/ }));

    expect(
      await screen.findByText(
        "Only the session's owner, an organization admin, or someone following its card can answer.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Which branch should this target?')).toBeInTheDocument();
  });

  it('shows a run that starts waiting while the page is open, once the feed says something changed', async () => {
    const feed = stubFactory();
    const inbox = stubWaiting([question]);
    renderRoute();
    expect(await screen.findByText('Which branch should this target?')).toBeInTheDocument();
    await waitFor(() => expect(feed.open).toBe(true));

    inbox.asks(inlinePlan);
    feed.push();

    expect(await screen.findByText('Add the toggle')).toBeInTheDocument();
  });

  it('counts what is waiting in the sidebar, and says when nothing is', async () => {
    stubFactory();
    stubWaiting([question, inlinePlan]);
    renderRoute();

    expect(await screen.findByRole('link', { name: 'Waiting, 2' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/waiting`,
    );
  });

  it('shows the empty state when no run waits on a person', async () => {
    stubFactory();
    stubWaiting([]);
    renderRoute();

    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Waiting' })).toBeInTheDocument();
  });
});
