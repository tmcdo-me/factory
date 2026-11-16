// fork(claude-agent)
import { buildTranscript, emptyTranscript } from '@factory/agent-runtime/browser';
import type { EventEnvelope, FactoryEvent } from '@factory/agent-runtime/browser';
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderHookWithProviders } from '../../../../../../e2e/ui/render';
import type { MessageEntry } from '../../services/transcript';
import { useFactorySessionTranscript } from '../useFactorySessionTranscript';

const SESSION = 's1';
const base = `${TEST_BASE_URL}/web/factory/sessions/${SESSION}`;

const envelope = (seq: number, event: FactoryEvent): EventEnvelope => ({
  sessionId: SESSION,
  seq,
  at: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
  event,
});

/** An SSE endpoint the test pushes frames into; records each request's `afterSeq`. */
function liveStream() {
  const encoder = new TextEncoder();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const afterSeqs: string[] = [];
  const handler = http.get(`${base}/events`, ({ request }) => {
    afterSeqs.push(new URL(request.url).searchParams.get('afterSeq') ?? '');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const push = (env: EventEnvelope) =>
    controllers.at(-1)!.enqueue(encoder.encode(`event: factory\nid: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`));
  return { handler, push, afterSeqs, connections: () => controllers.length };
}

const userTurn = (seq: number, id: string, text: string) => [
  envelope(seq, { type: 'message.started', messageId: id, role: 'user' }),
  envelope(seq + 1, { type: 'message.delta', messageId: id, part: 'text', delta: text }),
  envelope(seq + 2, { type: 'message.ended', messageId: id }),
];

describe('useFactorySessionTranscript', () => {
  it('loads the snapshot, then streams from its seq, drawing entries through the projection', async () => {
    const stream = liveStream();
    server.use(
      http.get(`${base}/transcript`, () => HttpResponse.json(buildTranscript(SESSION, userTurn(1, 'u1', 'Hello')))),
      stream.handler,
    );

    const { result } = renderHookWithProviders(() => useFactorySessionTranscript({ sessionId: SESSION }));

    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));
    expect(result.current.transcript.entries.map(e => e.id)).toEqual(['u1']);
    await waitFor(() => expect(stream.afterSeqs).toEqual(['3']));

    act(() => {
      stream.push(envelope(4, { type: 'run.started', runId: 'r1' }));
      stream.push(envelope(5, { type: 'message.started', messageId: 'a1', role: 'assistant', runId: 'r1' }));
      stream.push(envelope(6, { type: 'message.delta', messageId: 'a1', part: 'text', delta: 'Hi!' }));
    });
    await waitFor(() => expect(result.current.transcript.entries.map(e => e.id)).toEqual(['u1', 'a1']));
    expect(result.current.transcript.pending).toBe(true);
    const assistant = result.current.transcript.entries[1] as MessageEntry;
    expect(assistant.message.content.parts).toEqual([{ type: 'text', text: 'Hi!' }]);

    act(() => stream.push(envelope(7, { type: 'run.ended', runId: 'r1', reason: 'complete' })));
    await waitFor(() => expect(result.current.transcript.pending).toBe(false));
  });

  it('shows the sender their message at once and drops it when its echo arrives', async () => {
    const stream = liveStream();
    server.use(
      http.get(`${base}/transcript`, () => HttpResponse.json(emptyTranscript(SESSION))),
      stream.handler,
    );
    const { result } = renderHookWithProviders(() => useFactorySessionTranscript({ sessionId: SESSION }));
    await waitFor(() => expect(stream.connections()).toBe(1));

    let localId = '';
    act(() => {
      localId = result.current.localUser('Ship it ');
    });
    expect(result.current.transcript.entries.map(e => e.id)).toEqual([localId]);
    expect(result.current.transcript.pending).toBe(true);

    act(() => userTurn(1, 'u1', 'Ship it').forEach(stream.push));
    await waitFor(() => expect(result.current.transcript.entries.map(e => e.id)).toEqual(['u1']));
  });

  it('hides answered prompts, keeps local notices, and resyncs from a snapshot after a gap', async () => {
    const stream = liveStream();
    let snapshots = 0;
    const later = buildTranscript(SESSION, [...userTurn(1, 'u1', 'one'), ...userTurn(4, 'u2', 'two')]);
    server.use(
      http.get(`${base}/transcript`, () => {
        snapshots++;
        return HttpResponse.json(snapshots === 1 ? emptyTranscript(SESSION) : later);
      }),
      stream.handler,
    );
    const { result } = renderHookWithProviders(() => useFactorySessionTranscript({ sessionId: SESSION }));
    await waitFor(() => expect(stream.connections()).toBe(1));

    act(() => {
      stream.push(
        envelope(1, {
          type: 'interaction.requested',
          interaction: {
            id: 'i1',
            sessionId: SESSION,
            callId: 'c1',
            request: { kind: 'tool_approval', toolName: 'push', input: {} },
            requestedAt: 't',
          },
        }),
      );
    });
    await waitFor(() => expect(result.current.transcript.entries.map(e => e.id)).toEqual(['approval-c1']));
    act(() => {
      result.current.resolvePrompt('approval-c1');
      result.current.pushNotice('Approved');
    });
    expect(result.current.transcript.entries).toMatchObject([{ kind: 'notice', text: 'Approved' }]);

    // seq 5 after seq 1: events 2–4 were missed, so the hook refetches the transcript.
    act(() => stream.push(envelope(5, { type: 'message.ended', messageId: 'x' })));
    await waitFor(() => expect(snapshots).toBe(2), { timeout: 5_000 });
    await waitFor(() =>
      expect(result.current.transcript.entries.filter(e => e.kind === 'message').map(e => e.id)).toEqual(['u1', 'u2']),
    );
  });
});
