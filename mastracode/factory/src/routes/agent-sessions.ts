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
import type { CommandResult, SessionCommands, SessionEventHub } from '@factory/agent-runtime';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { getFactoryAuthUser } from '../auth.js';
import { loose } from './route.js';
import type { RouteAuth } from './route.js';

/** Proxies drop an idle stream, and `write` can't detect a dead peer. */
const KEEPALIVE_MS = 25_000;

/** Reads the whole log in pages so one huge session can't stall the event loop on a single query. */
const TRANSCRIPT_PAGE = 2_000;

export interface AgentSessionRoutesDependencies {
  auth: RouteAuth;
  events: SessionEventHub;
  /** Write commands; the read routes work without them. */
  commands?: SessionCommands;
}

const sendBody = z.object({
  text: z.string().min(1),
  files: z
    .array(z.object({ data: z.string().min(1), mediaType: z.string().min(1), filename: z.string().optional() }))
    .optional(),
});

const interactionResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), answer: z.union([z.string(), z.array(z.string())]) }),
  z.object({
    kind: z.literal('plan_approval'),
    action: z.enum(['approved', 'rejected']),
    feedback: z.string().optional(),
    plan: z
      .object({ path: z.string().optional(), title: z.string().optional(), content: z.string().optional() })
      .optional(),
  }),
  z.object({ kind: z.literal('tool_approval'), approved: z.boolean(), reason: z.string().optional() }),
]);

const answerBody = z
  .object({
    interactionId: z.string().min(1).optional(),
    callId: z.string().min(1).optional(),
    response: interactionResponse,
  })
  .refine(body => body.interactionId || body.callId, { message: 'Name interactionId or callId' });

const modelBody = z.object({
  modelId: z.string().min(1),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

const FAILURE_STATUS = { session_not_found: 404, not_pending: 409, invalid: 400, unavailable: 503 } as const;

function respond(c: Context, result: CommandResult) {
  if (result.ok) return c.json({ ok: true });
  return c.json(
    { ok: false, reason: result.reason, ...(result.message ? { message: result.message } : {}) },
    FAILURE_STATUS[result.reason],
  );
}

function afterSeqOf(c: Context): number | 'invalid' {
  const raw = c.req.header('last-event-id') ?? c.req.query('afterSeq');
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

/**
 * The request context a command runs with: the host's, plus the signed-in user. These routes skip the
 * server's auth layer (`requiresAuth: false`) and check the viewer themselves, so the server never
 * writes `user` into the request context; the session workspace needs it to know who is asking.
 */
function commandContext(c: Context): RequestContext {
  const host = c.get('requestContext' as never) as { entries?: () => Iterable<[string, unknown]> } | undefined;
  // oxlint-disable-next-line typescript/no-explicit-any -- a copy of the host's context, keys and all.
  const context = new RequestContext<any>(typeof host?.entries === 'function' ? [...host.entries()] : undefined);
  const user = getFactoryAuthUser(c);
  if (user && !context.get('user')) context.set('user', user);
  return context;
}

export function buildAgentSessionRoutes({ auth, events, commands }: AgentSessionRoutesDependencies): ApiRoute[] {
  const requireViewer = async (c: Context) => {
    if (!auth.enabled()) return true;
    await auth.ensureUser(c);
    return Boolean(auth.tenant(c));
  };

  /** A write route: signed-in viewer, parsed body, the host's request context passed through. */
  const command = <S extends z.ZodType>(
    path: string,
    method: 'POST' | 'PUT',
    schema: S | undefined,
    run: (commands: SessionCommands, sessionId: string, body: z.infer<S>, context: unknown) => Promise<CommandResult>,
  ) =>
    registerApiRoute(path, {
      method,
      requiresAuth: false,
      handler: async cc => {
        const c = loose(cc);
        if (!(await requireViewer(c))) return c.json({ error: 'unauthorized' }, 401);
        if (!commands) return c.json({ error: 'Session commands are not available' }, 503);
        const sessionId = c.req.param('sessionId');
        if (!sessionId) return c.json({ error: 'Session not found' }, 404);
        let body: z.infer<S> = undefined as z.infer<S>;
        if (schema) {
          const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
          if (!parsed.success) return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
          body = parsed.data;
        }
        return respond(c, await run(commands, sessionId, body, commandContext(c)));
      },
    });

  return [
    command('/web/factory/sessions/:sessionId/messages', 'POST', sendBody, (cmd, id, body, context) =>
      cmd.send(id, body, { context }),
    ),
    command('/web/factory/sessions/:sessionId/abort', 'POST', undefined, (cmd, id, _body, context) =>
      cmd.abort(id, { context }),
    ),
    command('/web/factory/sessions/:sessionId/interactions', 'POST', answerBody, (cmd, id, body, context) =>
      cmd.answer(id, { interactionId: body.interactionId, callId: body.callId }, body.response, { context }),
    ),
    // Only the session's owner may change its model; `createSessionAccessGuard` enforces that.
    command('/web/factory/sessions/:sessionId/model', 'PUT', modelBody, (cmd, id, body, context) =>
      cmd.setModel(id, body, { context }),
    ),
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
