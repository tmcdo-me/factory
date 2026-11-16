import type { AgentControllerSessionSettings } from '@mastra/client-js';
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../e2e/ui/render';
import { useAgentControllerSettings } from '../useAgentControllerSettings';
import { useSetAgentControllerStateMutation } from '../useAgentControllerStateMutations';

const controllerId = 'code';
const sessionId = 'session-test';
const sessionUrl = `${TEST_BASE_URL}/api/agent-controller/${controllerId}/sessions/${sessionId}`;
const hookArgs = {
  agentControllerId: controllerId,
  sessionId,
  baseUrl: TEST_BASE_URL,
  enabled: true,
};

function initialSettings(): AgentControllerSessionSettings {
  return {
    yolo: false,
    thinkingLevel: 'off',
    notifications: 'off',
    smartEditing: false,
  };
}

describe('agent-controller mutation hooks cache behavior', () => {
  it('does not refresh settings for a state update outside the settings slice', async () => {
    const settings = initialSettings();
    const onReadState = vi.fn();

    server.use(
      http.get(sessionUrl, () => {
        onReadState();
        return HttpResponse.json({ threadId: 'thread-one', settings });
      }),
      http.put(`${sessionUrl}/state`, () => HttpResponse.json({ ok: true })),
    );

    const { result, client } = renderHookWithProviders(() => ({
      settingsQuery: useAgentControllerSettings(hookArgs),
      setState: useSetAgentControllerStateMutation(hookArgs),
    }));

    await waitFor(() => expect(result.current.settingsQuery.data).toEqual(settings));
    await act(async () => result.current.setState.mutateAsync({ projectPath: '/sandbox/next' }));
    await waitForMutationsIdle(client);

    expect(onReadState).toHaveBeenCalledTimes(1);
  });

  it('refreshes settings when a state update includes the settings slice', async () => {
    let settings = initialSettings();
    const onReadState = vi.fn();

    server.use(
      http.get(sessionUrl, () => {
        onReadState();
        return HttpResponse.json({ threadId: 'thread-one', settings });
      }),
      http.put(`${sessionUrl}/state`, async ({ request }) => {
        const body = (await request.json()) as { state?: { settings?: AgentControllerSessionSettings } };
        settings = body.state?.settings ?? settings;
        return HttpResponse.json({ ok: true });
      }),
    );

    const { result, client } = renderHookWithProviders(() => ({
      settingsQuery: useAgentControllerSettings(hookArgs),
      setState: useSetAgentControllerStateMutation(hookArgs),
    }));

    await waitFor(() => expect(result.current.settingsQuery.data?.yolo).toBe(false));
    await act(async () => result.current.setState.mutateAsync({ settings: { ...settings, yolo: true } }));
    await waitForMutationsIdle(client);

    await waitFor(() => expect(result.current.settingsQuery.data?.yolo).toBe(true));
    expect(onReadState).toHaveBeenCalledTimes(2);
  });
});
