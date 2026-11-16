// fork(claude-agent)
import { InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import type { CommandResult, EventEnvelope, SessionCommands, Transcript } from '@factory/agent-runtime';
import { RequestContext } from '@mastra/core/request-context';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentSessionRoutes } from './agent-sessions.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const alice = { workosId: 'user-alice', organizationId: 'org-1' };

function buildApp(options: { user?: typeof alice; authEnabled?: boolean; commands?: SessionCommands } = {}) {
  const hub = new SessionEventHub(new InMemoryEventLog());
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (options.user) c.set('factoryAuthUser' as never, options.user as never);
    c.set('requestContext' as never, new RequestContext([['host-key', 'host-value']]) as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    buildAgentSessionRoutes({
      auth: fakeRouteAuth({ enabled: options.authEnabled }),
      events: hub,
      ...(options.commands ? { commands: options.commands } : {}),
    }),
  );
  return { app, hub };
}

/** Records every command; answers with `result`. */
function fakeCommands(result: CommandResult = { ok: true }) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const commands: SessionCommands = {
    send: record('send'),
    abort: record('abort'),
    answer: record('answer'),
    setModel: record('setModel'),
  };
  return { commands, calls };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

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
    expect(await res.json()).toEqual({ sessionId: 'none', lastSeq: 0, items: [], tasks: [] });
  });
});

describe('Factory session commands', () => {
  it('passes parsed commands and the host request context to the runtime', async () => {
    const { commands, calls } = fakeCommands();
    const { app } = buildApp({ user: alice, commands });

    expect(
      (
        await app.request(
          '/web/factory/sessions/s1/messages',
          json({ text: 'Hi', files: [{ data: 'aGk=', mediaType: 'text/plain' }] }),
        )
      ).status,
    ).toBe(200);
    expect((await app.request('/web/factory/sessions/s1/abort', { method: 'POST' })).status).toBe(200);
    const answer = { callId: 'c1', response: { kind: 'plan_approval', action: 'approved', plan: { path: 'p.md' } } };
    expect((await app.request('/web/factory/sessions/s1/interactions', json(answer))).status).toBe(200);
    expect(
      (await app.request('/web/factory/sessions/s1/model', json({ modelId: 'm', thinkingLevel: 'high' }, 'PUT')))
        .status,
    ).toBe(200);

    const ctx = expect.objectContaining({ context: expect.any(RequestContext) });
    expect(calls).toEqual([
      ['send', 's1', { text: 'Hi', files: [{ data: 'aGk=', mediaType: 'text/plain' }] }, ctx],
      ['abort', 's1', ctx],
      ['answer', 's1', { interactionId: undefined, callId: 'c1' }, answer.response, ctx],
      ['setModel', 's1', { modelId: 'm', thinkingLevel: 'high' }, ctx],
    ]);
    // The host's context is carried over, and the signed-in user is added: these routes check the
    // viewer themselves, so the server's auth layer never put `user` there (regression: Claude Agent
    // sessions failed with "resolved without a caller identity").
    for (const call of calls) {
      const context = (call.at(-1) as { context: RequestContext }).context;
      expect(context.get('host-key')).toBe('host-value');
      expect(context.get('user')).toEqual(alice);
    }
  });

  it('rejects malformed bodies before reaching the runtime', async () => {
    const { commands, calls } = fakeCommands();
    const { app } = buildApp({ user: alice, commands });
    expect((await app.request('/web/factory/sessions/s1/messages', json({ text: '' }))).status).toBe(400);
    expect(
      (
        await app.request(
          '/web/factory/sessions/s1/interactions',
          json({ response: { kind: 'question', answer: 'x' } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request('/web/factory/sessions/s1/interactions', json({ callId: 'c', response: { kind: 'nope' } })))
        .status,
    ).toBe(400);
    expect(
      (await app.request('/web/factory/sessions/s1/model', json({ modelId: 'm', thinkingLevel: 'ultra' }, 'PUT')))
        .status,
    ).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    [{ ok: false, reason: 'session_not_found' } as const, 404],
    [{ ok: false, reason: 'not_pending', message: 'stale_tool_call' } as const, 409],
    [{ ok: false, reason: 'invalid' } as const, 400],
  ])('maps a runtime refusal %o to HTTP %i', async (result, status) => {
    const { commands } = fakeCommands(result);
    const res = await buildApp({ user: alice, commands }).app.request('/web/factory/sessions/s1/abort', {
      method: 'POST',
    });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(result);
  });

  it('needs a signed-in user and configured commands', async () => {
    expect(
      (
        await buildApp({ commands: fakeCommands().commands }).app.request('/web/factory/sessions/s1/abort', {
          method: 'POST',
        })
      ).status,
    ).toBe(401);
    expect(
      (await buildApp({ user: alice }).app.request('/web/factory/sessions/s1/abort', { method: 'POST' })).status,
    ).toBe(503);
  });
});
