// fork(claude-agent)
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderHookWithProviders } from '../../../../../../e2e/ui/render';
import {
  useAbortAgentControllerMutation,
  useSendAgentControllerMessageMutation,
} from '../../../../../hooks/useAgentControllerRunMutations';
import { draftRuntimeChoice } from '../useSessionRuntime';

function recordSessionTraffic(sessionId: string, runtimeId: string) {
  const hits: string[] = [];
  server.use(
    http.get(`*/web/factory/sessions/${sessionId}/runtime`, () => HttpResponse.json({ runtimeId })),
    http.post(`*/web/factory/sessions/${sessionId}/:command`, ({ params }) => {
      hits.push(`factory:${String(params.command)}`);
      return HttpResponse.json({ ok: true });
    }),
    http.post(`*/api/agent-controller/:controllerId/sessions/${sessionId}/:command`, ({ params }) => {
      hits.push(`mastra:${String(params.command)}`);
      return HttpResponse.json({ ok: true });
    }),
  );
  return hits;
}

const args = (sessionId: string) => ({ agentControllerId: 'code', sessionId, baseUrl: TEST_BASE_URL });

describe('session commands follow the session runtime', () => {
  it("sends a Claude Agent session's commands to Factory's session API", async () => {
    const hits = recordSessionTraffic('claude-1', 'claude-agent');
    const { result } = renderHookWithProviders(() => ({
      send: useSendAgentControllerMessageMutation(args('claude-1')),
      abort: useAbortAgentControllerMutation(args('claude-1')),
    }));

    await act(async () => {
      await result.current.send.mutateAsync('Fix the test');
      await result.current.abort.mutateAsync();
    });
    await waitFor(() => expect(hits).toEqual(['factory:messages', 'factory:abort']));
  });

  it("keeps a Mastra Code session's commands on the agent-controller routes", async () => {
    const hits = recordSessionTraffic('mastra-1', 'mastra-code');
    const { result } = renderHookWithProviders(() => useSendAgentControllerMessageMutation(args('mastra-1')));

    await act(async () => {
      await result.current.mutateAsync('Fix the test');
    });
    await waitFor(() => expect(hits).toEqual(['mastra:messages']));
  });
});

describe('draftRuntimeChoice', () => {
  it('uses the project default until the composer picks, and gives Claude Agent a model', () => {
    expect(draftRuntimeChoice('draft-a', undefined)).toEqual({ runtimeId: 'mastra-code' });
    expect(draftRuntimeChoice('draft-a', 'claude-agent')).toEqual({
      runtimeId: 'claude-agent',
      modelId: 'claude-opus-5-5',
    });
  });
});
