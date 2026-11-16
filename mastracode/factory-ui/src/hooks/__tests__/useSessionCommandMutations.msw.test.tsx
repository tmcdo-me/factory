// @vitest-environment jsdom
// fork(claude-agent): every session's writes go through Factory's session API.
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import {
  isEndedPrompt,
  RejectedReplyError,
  useAbortSessionMutation,
  useApproveSessionToolMutation,
  useRespondSessionPromptMutation,
  useSendSessionMessageMutation,
  useSwitchSessionModelMutation,
} from '../useSessionCommandMutations';

const sessionId = 'mastra-1';
const args = { sessionId, baseUrl: TEST_BASE_URL };

function recordSessionTraffic() {
  const hits: string[] = [];
  server.use(
    http.get(`*/web/factory/sessions/${sessionId}/runtime`, () => HttpResponse.json({ runtimeId: 'mastra-code' })),
    http.all(`*/web/factory/sessions/${sessionId}/:command`, ({ request, params }) => {
      hits.push(`factory:${request.method} ${String(params.command)}`);
      return HttpResponse.json({ ok: true });
    }),
    http.all(`*/api/agent-controller/*`, ({ request }) => {
      hits.push(`mastra:${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ ok: true });
    }),
  );
  return hits;
}

describe('session commands', () => {
  it("drive a Mastra Code session through Factory's session API, never Mastra's agent-controller routes", async () => {
    const hits = recordSessionTraffic();
    const { result } = renderHookWithProviders(() => ({
      send: useSendSessionMessageMutation(args),
      abort: useAbortSessionMutation(args),
      approve: useApproveSessionToolMutation(args),
      respond: useRespondSessionPromptMutation(args),
      switchModel: useSwitchSessionModelMutation(args),
    }));

    await act(async () => {
      await result.current.send.mutateAsync('Fix the test');
      await result.current.abort.mutateAsync();
      await result.current.approve.mutateAsync({ toolCallId: 'call-1', approved: true });
      await result.current.respond.mutateAsync({ toolCallId: 'call-2', resumeData: 'Yes' });
      await result.current.switchModel.mutateAsync({ modelId: 'openai/gpt-5', thinkingLevel: 'high' });
    });

    await waitFor(() =>
      expect(hits).toEqual([
        'factory:POST messages',
        'factory:POST abort',
        'factory:POST interactions',
        'factory:POST interactions',
        'factory:PUT model',
      ]),
    );
  });

  it('given the run behind a shown plan has gone away, when the plan is approved, then the prompt ends', async () => {
    // What Factory answers when Mastra Code finds nothing waiting on the call.
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/sessions/${sessionId}/interactions`, () =>
        HttpResponse.json({ ok: false, reason: 'not_pending', message: 'no_pending_suspension' }, { status: 409 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useRespondSessionPromptMutation(args));

    await act(async () => {
      await result.current
        .mutateAsync({ toolCallId: 'call-1', resumeData: { action: 'approved' } })
        .catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/no longer waiting/);
    expect(isEndedPrompt(result.current.error)).toBe(true);
  });

  it('only treats a reply with nothing waiting as an ended prompt', () => {
    expect(isEndedPrompt(new RejectedReplyError('no_pending_suspension'))).toBe(true);
    expect(isEndedPrompt(new RejectedReplyError('not_pending'))).toBe(false);
    expect(isEndedPrompt(new Error('network'))).toBe(false);
  });
});
