// fork(claude-agent)
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import {
  abortFactorySession,
  approveFactorySessionTool,
  respondToFactorySessionPrompt,
  sendFactorySessionMessage,
  switchFactorySessionModel,
} from '../factorySessionCommands';

const base = `${TEST_BASE_URL}/web/factory/sessions/s1`;

function recordRequests(status = 200, body: Record<string, unknown> = { ok: true }) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.all(`${base}/*`, async ({ request }) => {
      const text = await request.text();
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      return HttpResponse.json(body, { status });
    }),
  );
  return seen;
}

describe('Factory session commands client', () => {
  it('sends each command to its Factory route with the runtime-neutral body', async () => {
    const seen = recordRequests();
    await sendFactorySessionMessage(TEST_BASE_URL, 's1', {
      text: 'Hi',
      files: [{ data: 'aGk=', mediaType: 'text/plain' }],
    });
    await abortFactorySession(TEST_BASE_URL, 's1');
    await approveFactorySessionTool(TEST_BASE_URL, 's1', 'c1', false);
    await respondToFactorySessionPrompt(TEST_BASE_URL, 's1', 'q1', ['A', 'B']);
    await respondToFactorySessionPrompt(TEST_BASE_URL, 's1', 'p1', {
      action: 'rejected',
      feedback: 'Smaller steps',
      path: 'plan.md',
      title: 'Fix it',
      plan: '# Plan',
    });
    await switchFactorySessionModel(TEST_BASE_URL, 's1', 'anthropic/claude-opus-5-5', 'high');

    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/web/factory/sessions/s1/messages',
        body: { text: 'Hi', files: [{ data: 'aGk=', mediaType: 'text/plain' }] },
      },
      { method: 'POST', path: '/web/factory/sessions/s1/abort', body: undefined },
      {
        method: 'POST',
        path: '/web/factory/sessions/s1/interactions',
        body: { callId: 'c1', response: { kind: 'tool_approval', approved: false } },
      },
      {
        method: 'POST',
        path: '/web/factory/sessions/s1/interactions',
        body: { callId: 'q1', response: { kind: 'question', answer: ['A', 'B'] } },
      },
      {
        method: 'POST',
        path: '/web/factory/sessions/s1/interactions',
        body: {
          callId: 'p1',
          response: {
            kind: 'plan_approval',
            action: 'rejected',
            feedback: 'Smaller steps',
            plan: { path: 'plan.md', title: 'Fix it', content: '# Plan' },
          },
        },
      },
      {
        method: 'PUT',
        path: '/web/factory/sessions/s1/model',
        body: { modelId: 'anthropic/claude-opus-5-5', thinkingLevel: 'high' },
      },
    ]);
  });

  it("resolves a refused reply with the runtime's reason, and throws other failures", async () => {
    recordRequests(409, { ok: false, reason: 'not_pending', message: 'no_pending_suspension' });
    await expect(respondToFactorySessionPrompt(TEST_BASE_URL, 's1', 'q1', 'yes')).resolves.toEqual({
      ok: false,
      reason: 'no_pending_suspension',
    });
    await expect(abortFactorySession(TEST_BASE_URL, 's1')).rejects.toMatchObject({ status: 409 });

    recordRequests(404, { ok: false, reason: 'session_not_found', message: 'No session "s1"' });
    await expect(sendFactorySessionMessage(TEST_BASE_URL, 's1', { text: 'hi' })).rejects.toThrow('No session "s1"');
  });
});
