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
function mastraCodeSessionOnTheLog(history: FactoryEvent[]) {
  const encoder = new TextEncoder();
  let seq = history.length;
  let push: (event: FactoryEvent) => void = () => {
    throw new Error('event stream not open');
  };
  const agentControllerTraffic: string[] = [];
  const sessionApi = `${TEST_BASE_URL}/web/factory/sessions/${SESSION_ID}`;
  server.use(
    http.get(`${sessionApi}/runtime`, () => HttpResponse.json({ runtimeId: 'mastra-code', transcript: 'factory' })),
    http.get(`${sessionApi}/transcript`, () =>
      HttpResponse.json(
        buildTranscript(
          SESSION_ID,
          history.map((event, index) => envelope(index + 1, event)),
        ),
      ),
    ),
    http.get(
      `${sessionApi}/events`,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = event => {
                const env = envelope(++seq, event);
                controller.enqueue(encoder.encode(`event: factory\nid: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`));
              };
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
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
  };
}

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
});
