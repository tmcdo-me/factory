// fork(claude-agent): a Mastra Code session is drawn, and its runtime state read, from Factory's event log.
import { buildTranscript } from '@factory/agent-runtime/browser';
import type { EventEnvelope, FactoryEvent } from '@factory/agent-runtime/browser';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { SESSION_ID, releaseSession, renderThread, stubPreparingSession } from './composer-session-test-fixture';

const envelope = (seq: number, event: FactoryEvent): EventEnvelope => ({
  sessionId: SESSION_ID,
  seq,
  at: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
  event,
});

const firstTurn: FactoryEvent[] = [
  { type: 'message.started', messageId: 'u1', role: 'user' },
  { type: 'message.delta', messageId: 'u1', part: 'text', delta: 'Where does auth start?' },
  { type: 'message.ended', messageId: 'u1' },
  { type: 'run.started', runId: 'r1' },
  { type: 'message.started', messageId: 'a1', role: 'assistant', runId: 'r1' },
  { type: 'message.delta', messageId: 'a1', part: 'text', delta: 'Auth starts at the composer.' },
  { type: 'message.ended', messageId: 'a1' },
  { type: 'usage', runId: 'r1', inputTokens: 1_200, outputTokens: 300, contextTokens: 1_200 },
  { type: 'run.ended', runId: 'r1', reason: 'complete' },
];

/** A Mastra Code session as the server serves it now: from its event log, and live from its stream. */
function mastraCodeSessionOnTheLog(history: FactoryEvent[], { transcriptStatus }: { transcriptStatus?: number } = {}) {
  const encoder = new TextEncoder();
  let seq = history.length;
  let push: (event: FactoryEvent) => void = () => {
    throw new Error('event stream not open');
  };
  const agentControllerTraffic: string[] = [];
  const answers: unknown[] = [];
  const sessionApi = `${TEST_BASE_URL}/web/factory/sessions/${SESSION_ID}`;
  server.use(
    http.get(`${sessionApi}/runtime`, () => HttpResponse.json({ runtimeId: 'mastra-code', transcript: 'factory' })),
    http.get(`${sessionApi}/transcript`, () =>
      transcriptStatus
        ? HttpResponse.json({ error: 'Session not found' }, { status: transcriptStatus })
        : HttpResponse.json(
            buildTranscript(
              SESSION_ID,
              history.map((event, index) => envelope(index + 1, event)),
            ),
          ),
    ),
    http.post(`${sessionApi}/interactions`, async ({ request }) => {
      answers.push(await request.json());
      return HttpResponse.json({ ok: true });
    }),
    http.get(`${sessionApi}/events`, () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = event => {
              const env = envelope(++seq, event);
              controller.enqueue(encoder.encode(`event: factory\nid: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`));
            };
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
    // Mastra's session stream and session creation are Mastra's own transport; nothing should use them.
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:id/stream`, ({ request }) => {
      agentControllerTraffic.push(`GET ${new URL(request.url).pathname}`);
      return HttpResponse.json({}, { status: 500 });
    }),
    http.post(`${TEST_BASE_URL}/api/agent-controller/code/sessions`, ({ request }) => {
      agentControllerTraffic.push(`POST ${new URL(request.url).pathname}`);
      return HttpResponse.json({}, { status: 500 });
    }),
  );
  return {
    push: async (event: FactoryEvent) => {
      await waitFor(() => push(event));
    },
    agentControllerTraffic,
    answers,
  };
}

const asked = (
  callId: string,
  request: Extract<FactoryEvent, { type: 'interaction.requested' }>['interaction']['request'],
) =>
  ({
    type: 'interaction.requested',
    interaction: { id: `${request.kind}:${callId}`, sessionId: SESSION_ID, callId, request, requestedAt: 't' },
  }) satisfies FactoryEvent;

const abort = () => screen.queryByRole('button', { name: 'Abort' });

describe('a Mastra Code session drawn from Factory’s event log', () => {
  it('shows its history, and runs as running and stopped from the log, without Mastra’s stream', async () => {
    const session = stubPreparingSession({ materialized: true });
    const factory = mastraCodeSessionOnTheLog(firstTurn);
    const { client } = renderThread();
    await releaseSession(session.finishWorkspace, client);

    expect(await screen.findByText('Auth starts at the composer.')).toBeInTheDocument();
    expect(abort()).toBeNull();

    await factory.push({ type: 'run.started', runId: 'r2' });
    await waitFor(() => expect(abort()).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Steer the agent');

    await factory.push({ type: 'run.ended', runId: 'r2', reason: 'complete' });
    await waitFor(() => expect(abort()).toBeNull());

    expect(factory.agentControllerTraffic).toEqual([]);
  });

  it('reports the usage the log recorded', async () => {
    const session = stubPreparingSession({ materialized: true });
    mastraCodeSessionOnTheLog(firstTurn);
    const user = userEvent.setup();
    const { client } = renderThread();
    await releaseSession(session.finishWorkspace, client);
    await screen.findByText('Auth starts at the composer.');

    const message = screen.getByRole('textbox', { name: 'Message' });
    await user.type(message, '/cost{enter}');

    expect(await screen.findByText('Used 1500 tokens (1200 prompt, 300 completion).')).toBeInTheDocument();
  });

  it('stops the run through Factory’s session API', async () => {
    const session = stubPreparingSession({ materialized: true, autoAgentEnd: false });
    const factory = mastraCodeSessionOnTheLog(firstTurn);
    const user = userEvent.setup();
    const { client } = renderThread();
    await releaseSession(session.finishWorkspace, client);
    await factory.push({ type: 'run.started', runId: 'r2' });

    await user.click(await screen.findByRole('button', { name: 'Abort' }));

    await waitFor(() => expect(session.abortRequests).toBe(1));
  });

  describe('when the agent waits on the person', () => {
    async function openWaitingSession() {
      const session = stubPreparingSession({ materialized: true, autoAgentEnd: false });
      const factory = mastraCodeSessionOnTheLog([...firstTurn, { type: 'run.started', runId: 'r2' }]);
      const user = userEvent.setup();
      const { client } = renderThread();
      await releaseSession(session.finishWorkspace, client);
      await screen.findByText('Auth starts at the composer.');
      return { factory, user };
    }

    it.each([
      ['Approve', true],
      ['Decline', false],
    ] as const)('%ss a tool call through Factory\u2019s session API', async (label, approved) => {
      const { factory, user } = await openWaitingSession();
      await factory.push(
        asked('call-w', { kind: 'tool_approval', toolName: 'write_file', input: { path: 'src/agent.ts' } }),
      );

      await user.click(await screen.findByRole('button', { name: `${label} write_file` }));

      await waitFor(() =>
        expect(factory.answers).toEqual([{ callId: 'call-w', response: { kind: 'tool_approval', approved } }]),
      );
      await factory.push({
        type: 'interaction.resolved',
        interactionId: 'tool_approval:call-w',
        response: { kind: 'tool_approval', approved },
      });
      await waitFor(() => expect(screen.queryByRole('button', { name: `${label} write_file` })).toBeNull());
    });

    it('answers an ask_user question through Factory\u2019s session API', async () => {
      const { factory, user } = await openWaitingSession();
      await factory.push(
        asked('call-q', {
          kind: 'question',
          question: 'Which client should the page use?',
          options: [{ label: 'Keep the current client' }, { label: 'Add a narrow RPC type' }],
        }),
      );

      expect(await screen.findByText('Which client should the page use?')).toBeInTheDocument();
      await user.click(screen.getByRole('radio', { name: 'Keep the current client' }));

      await waitFor(() =>
        expect(factory.answers).toEqual([
          { callId: 'call-q', response: { kind: 'question', answer: 'Keep the current client' } },
        ]),
      );
    });

    it('approves a plan through Factory\u2019s session API, with the plan as shown', async () => {
      const { factory, user } = await openWaitingSession();
      await factory.push(
        asked('call-p', {
          kind: 'plan_approval',
          planPath: '.artifacts/plans/ship.md',
          plan: '# Ship it\n\nAdd the feature.',
        }),
      );

      await user.click(await screen.findByRole('button', { name: 'Approve the plan and build it' }));

      await waitFor(() =>
        expect(factory.answers).toEqual([
          {
            callId: 'call-p',
            response: expect.objectContaining({
              kind: 'plan_approval',
              action: 'approved',
              plan: expect.objectContaining({ path: '.artifacts/plans/ship.md' }),
            }),
          },
        ]),
      );
    });
  });

  describe('while its stream is not connected', () => {
    const send = () => screen.getByRole('button', { name: 'Send message' });

    it('holds sending while the stream reconnects, and sends again once it is back', async () => {
      let reopen = () => {};
      const reopened = new Promise<void>(resolve => {
        reopen = resolve;
      });
      const session = stubPreparingSession({ materialized: true });
      mastraCodeSessionOnTheLog(firstTurn);
      // The first stream is dropped at once; the next one opens only when the test says so.
      let streams = 0;
      server.use(
        http.get(`${TEST_BASE_URL}/web/factory/sessions/${SESSION_ID}/events`, async () => {
          streams += 1;
          if (streams > 1) await reopened;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (streams === 1) controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }),
      );
      const user = userEvent.setup();
      const { client } = renderThread();
      await releaseSession(session.finishWorkspace, client);
      await screen.findByText('Auth starts at the composer.');

      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'And the logout?');
      await waitFor(() => expect(send()).toBeDisabled());

      reopen();
      await waitFor(() => expect(send()).toBeEnabled(), { timeout: 5_000 });
    });

    it('never sends to a session the server refuses', async () => {
      const session = stubPreparingSession({ materialized: true });
      mastraCodeSessionOnTheLog(firstTurn, { transcriptStatus: 404 });
      const user = userEvent.setup();
      const { client } = renderThread();
      await releaseSession(session.finishWorkspace, client);

      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello?');

      await waitFor(() => expect(send()).toBeDisabled());
      expect(session.posted).toEqual([]);
    });
  });

  it('says it could not read the session while the server cannot tell where its history lives, and retries', async () => {
    const session = stubPreparingSession({ materialized: true });
    mastraCodeSessionOnTheLog(firstTurn);
    let answer = 503;
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/sessions/${SESSION_ID}/runtime`, () =>
        answer === 503
          ? HttpResponse.json({ error: 'unavailable', message: 'Try again.' }, { status: 503 })
          : HttpResponse.json({ runtimeId: 'mastra-code', transcript: 'factory' }),
      ),
    );
    const user = userEvent.setup();
    renderThread();
    session.finishWorkspace();

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/Failed to load messages/)).toBeInTheDocument();
    expect(screen.queryByText('Auth starts at the composer.')).toBeNull();

    answer = 200;
    await user.click(retry);
    expect(await screen.findByText('Auth starts at the composer.')).toBeInTheDocument();
  });
});
