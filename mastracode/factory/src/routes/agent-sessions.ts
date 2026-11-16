// fork(claude-agent): Factory-owned session API over the agent runtime seam.
/**
 * Runtime-neutral session reads for the Factory UI:
 *
 * - `GET /web/factory/sessions/:sessionId/events` — SSE of the session's `FactoryEvent`s: stored
 *   events after `afterSeq` (query) or `Last-Event-ID` (reconnect), then live ones. Each frame is
 *   `event: factory`, `id: <seq>`, `data: <EventEnvelope JSON>`.
 * - `GET /web/factory/sessions/:sessionId/transcript` — the reduced `Transcript`.
 *
 * Who may read a session is decided by `createSessionAccessGuard`, which matches these paths;
 * the handlers only require a signed-in user when auth is on.
 */
import { buildTranscript } from '@factory/agent-runtime';
import type { SessionEventHub } from '@factory/agent-runtime';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { loose } from './route.js';
import type { RouteAuth } from './route.js';

/** Proxies drop an idle stream, and `write` can't detect a dead peer. */
const KEEPALIVE_MS = 25_000;

/** Reads the whole log in pages so one huge session can't stall the event loop on a single query. */
const TRANSCRIPT_PAGE = 2_000;

export interface AgentSessionRoutesDependencies {
  auth: RouteAuth;
  events: SessionEventHub;
}

function afterSeqOf(c: Context): number | 'invalid' {
  const raw = c.req.header('last-event-id') ?? c.req.query('afterSeq');
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

export function buildAgentSessionRoutes({ auth, events }: AgentSessionRoutesDependencies): ApiRoute[] {
  const requireViewer = async (c: Context) => {
    if (!auth.enabled()) return true;
    await auth.ensureUser(c);
    return Boolean(auth.tenant(c));
  };

  return [
    registerApiRoute('/web/factory/sessions/:sessionId/events', {
      method: 'GET',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        if (!(await requireViewer(c))) return c.json({ error: 'unauthorized' }, 401);
        const sessionId = c.req.param('sessionId');
        if (!sessionId) return c.json({ error: 'Session not found' }, 404);
        const afterSeq = afterSeqOf(c);
        if (afterSeq === 'invalid') return c.json({ error: 'afterSeq must be a non-negative integer' }, 400);

        return streamSSE(c, async stream => {
          const controller = new AbortController();
          stream.onAbort(() => controller.abort());
          const ping = () => {
            if (!stream.aborted) void stream.write(': ping\n\n');
          };
          ping(); // flush headers through proxies that wait for the first byte
          const keepalive = setInterval(ping, KEEPALIVE_MS);
          try {
            for await (const envelope of events.subscribe(sessionId, { afterSeq, signal: controller.signal })) {
              if (stream.aborted) break;
              await stream.writeSSE({ event: 'factory', id: String(envelope.seq), data: JSON.stringify(envelope) });
            }
          } catch (error) {
            if (!stream.aborted) {
              console.warn(
                `[factory] session event stream for ${sessionId} failed: ${error instanceof Error ? error.message : error}`,
              );
            }
          } finally {
            clearInterval(keepalive);
            controller.abort();
          }
        });
      },
    }),
    registerApiRoute('/web/factory/sessions/:sessionId/transcript', {
      method: 'GET',
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        if (!(await requireViewer(c))) return c.json({ error: 'unauthorized' }, 401);
        const sessionId = c.req.param('sessionId');
        if (!sessionId) return c.json({ error: 'Session not found' }, 404);

        const envelopes = [];
        for (let afterSeq = 0; ;) {
          const page = await events.log.list(sessionId, { afterSeq, limit: TRANSCRIPT_PAGE });
          envelopes.push(...page);
          if (page.length < TRANSCRIPT_PAGE) break;
          afterSeq = page.at(-1)!.seq;
        }
        return c.json(buildTranscript(sessionId, envelopes));
      },
    }),
  ];
}
