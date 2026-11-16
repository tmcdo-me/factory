// fork(claude-agent)
import { InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import type { EventEnvelope, Transcript } from '@factory/agent-runtime';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentSessionRoutes } from './agent-sessions.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const alice = { workosId: 'user-alice', organizationId: 'org-1' };

function buildApp(options: { user?: typeof alice; authEnabled?: boolean } = {}) {
  const hub = new SessionEventHub(new InMemoryEventLog());
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (options.user) c.set('factoryAuthUser' as never, options.user as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    buildAgentSessionRoutes({ auth: fakeRouteAuth({ enabled: options.authEnabled }), events: hub }),
  );
  return { app, hub };
}

/** Reads SSE frames incrementally; `stop()` cancels the body, which aborts the stream server-side. */
function openStream(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { event?: string; id?: string; data?: string }[] = [];
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const lines = buffer.slice(0, sep).split('\n');
        buffer = buffer.slice(sep + 2);
        const field = (name: string) =>
          lines
            .find(line => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        if (field('event')) frames.push({ event: field('event'), id: field('id'), data: field('data') });
      }
    }
  })();
  return {
    frames,
    envelopes: () => frames.map(frame => JSON.parse(frame.data!) as EventEnvelope),
    async stop() {
      await reader.cancel();
      await pump;
    },
  };
}

describe('Factory session event stream', () => {
  it('replays stored events, then streams live ones, with seq as the SSE id', async () => {
    const { app, hub } = buildApp({ user: alice });
    await hub.publish('s1', { type: 'run.started', runId: 'r1' });

    const res = await app.request('/web/factory/sessions/s1/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = openStream(res);

    await vi.waitFor(() => expect(stream.frames).toHaveLength(1));
    await hub.publish('s1', { type: 'run.ended', runId: 'r1', reason: 'complete' });
    await vi.waitFor(() => expect(stream.frames).toHaveLength(2));

    expect(stream.frames.map(f => [f.event, f.id])).toEqual([
      ['factory', '1'],
      ['factory', '2'],
    ]);
    expect(stream.envelopes().map(e => e.event.type)).toEqual(['run.started', 'run.ended']);
    await stream.stop();
  });

  it('resumes after Last-Event-ID (reconnect) or afterSeq', async () => {
    const { app, hub } = buildApp({ user: alice });
    await hub.publish(
      's1',
      { type: 'message.started', messageId: 'm', role: 'assistant' },
      { type: 'message.delta', messageId: 'm', part: 'text', delta: 'a' },
      { type: 'message.ended', messageId: 'm' },
    );

    const reconnect = openStream(
      await app.request('/web/factory/sessions/s1/events', { headers: { 'Last-Event-ID': '2' } }),
    );
    await vi.waitFor(() => expect(reconnect.frames.map(f => f.id)).toEqual(['3']));
    await reconnect.stop();

    const fromQuery = openStream(await app.request('/web/factory/sessions/s1/events?afterSeq=1'));
    await vi.waitFor(() => expect(fromQuery.frames.map(f => f.id)).toEqual(['2', '3']));
    await fromQuery.stop();
  });

  it('rejects a malformed afterSeq and a signed-out caller', async () => {
    expect((await buildApp({ user: alice }).app.request('/web/factory/sessions/s1/events?afterSeq=-1')).status).toBe(
      400,
    );
    expect((await buildApp().app.request('/web/factory/sessions/s1/events')).status).toBe(401);
    expect((await buildApp({ authEnabled: false }).app.request('/web/factory/sessions/s1/transcript')).status).toBe(
      200,
    );
  });
});

describe('Factory session transcript', () => {
  it('returns the reduced transcript', async () => {
    const { app, hub } = buildApp({ user: alice });
    await hub.publish(
      's1',
      { type: 'run.started', runId: 'r1' },
      {
        type: 'tool.started',
        callId: 'c1',
        name: 'view',
        category: 'file.read',
        executor: 'runtime',
        input: { path: 'a' },
      },
      { type: 'tool.ended', callId: 'c1', result: 'ok' },
      { type: 'run.ended', runId: 'r1', reason: 'complete' },
    );

    const res = await app.request('/web/factory/sessions/s1/transcript');
    expect(res.status).toBe(200);
    const transcript = (await res.json()) as Transcript;
    expect(transcript).toMatchObject({
      sessionId: 's1',
      lastSeq: 4,
      items: [
        { kind: 'run', status: 'complete' },
        { kind: 'tool', callId: 'c1', status: 'done', result: 'ok' },
      ],
    });
  });

  it('returns an empty transcript for a session with no events', async () => {
    const res = await buildApp({ user: alice }).app.request('/web/factory/sessions/none/transcript');
    expect(await res.json()).toEqual({ sessionId: 'none', lastSeq: 0, items: [] });
  });
});
