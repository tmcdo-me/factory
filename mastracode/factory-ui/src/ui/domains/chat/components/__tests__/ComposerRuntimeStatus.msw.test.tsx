// fork(claude-agent): the composer names the session's runtime and shows the meters that apply to it.
import { buildTranscript } from '@factory/agent-runtime/browser';
import type { EventEnvelope, FactoryEvent } from '@factory/agent-runtime/browser';
import type { AgentControllerOMProgress } from '@mastra/client-js';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import {
  FACTORY_ID,
  SESSION_ID,
  releaseSession,
  renderDraft,
  renderThread,
  stubPreparingSession,
} from './composer-session-test-fixture';

const omProgress: AgentControllerOMProgress = {
  status: 'idle',
  pendingTokens: 0,
  threshold: 30_000,
  thresholdPercent: 0,
  observationTokens: 0,
  reflectionThreshold: 40_000,
  reflectionThresholdPercent: 0,
  projectedMessageRemoval: 0,
  projectedReflectionSavings: 0,
};

/** The Mastra session snapshot carries the observational-memory budgets, whatever the runtime. */
function withObservationalMemory() {
  server.use(
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:resourceId`, ({ params }) =>
      HttpResponse.json({
        controllerId: 'code',
        resourceId: params.resourceId,
        modeId: 'build',
        modelId: 'openai/gpt-4o-mini',
        threadId: SESSION_ID,
        omProgress,
        settings: { yolo: false, thinkingLevel: 'medium', notifications: 'bell', smartEditing: true },
      }),
    ),
  );
}

const envelope = (seq: number, event: FactoryEvent): EventEnvelope => ({
  sessionId: SESSION_ID,
  seq,
  at: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
  event,
});

/** A Claude Agent session: its transcript and live events come from Factory's session API. */
function claudeAgentSession(history: FactoryEvent[]) {
  const encoder = new TextEncoder();
  let push: (env: EventEnvelope) => void = () => {
    throw new Error('event stream not open');
  };
  const sessionApi = `${TEST_BASE_URL}/web/factory/sessions/${SESSION_ID}`;
  server.use(
    http.get(`${sessionApi}/runtime`, () =>
      HttpResponse.json({ runtimeId: 'claude-agent', modelId: 'claude-opus-5-5' }),
    ),
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
              push = env =>
                controller.enqueue(encoder.encode(`event: factory\nid: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  return { push: (env: EventEnvelope) => push(env) };
}

const claudeTurn: FactoryEvent[] = [
  { type: 'message.started', messageId: 'u1', role: 'user' },
  { type: 'message.delta', messageId: 'u1', part: 'text', delta: 'Fix the flaky test' },
  { type: 'message.ended', messageId: 'u1' },
  { type: 'run.started', runId: 'r1' },
  { type: 'message.started', messageId: 'a1', role: 'assistant', runId: 'r1' },
  { type: 'message.delta', messageId: 'a1', part: 'text', delta: 'Fixed.' },
  { type: 'message.ended', messageId: 'a1' },
  {
    type: 'usage',
    runId: 'r1',
    inputTokens: 30,
    outputTokens: 900,
    cachedInputTokens: 81_000,
    contextTokens: 41_120,
    contextWindow: 200_000,
  },
  { type: 'run.ended', runId: 'r1', reason: 'complete' },
];

const messageBox = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

describe('composer runtime status', () => {
  describe('in a Mastra Code session', () => {
    it('asks Mastra Code, keeps the memory budgets, and meters the context of the latest step without a limit', async () => {
      const session = stubPreparingSession();
      withObservationalMemory();
      const { client } = renderThread();
      await releaseSession(session.finishWorkspace, client);

      await waitFor(() => expect(messageBox().placeholder).toBe('Ask Mastra Code'));
      expect(await screen.findByRole('button', { name: /^Memory budgets:/ })).toBeVisible();
      expect(screen.queryByRole('button', { name: /^Context window/ })).toBeNull();

      // One step's prompt is the context; the session's running total is not.
      await session.emit({
        type: 'usage_update',
        usage: { promptTokens: 12_300, completionTokens: 400, totalTokens: 12_700 },
      });
      await session.emit({
        type: 'display_state_changed',
        displayState: { tokenUsage: { promptTokens: 30_000, completionTokens: 900, totalTokens: 30_900 } },
      });

      // The catalog knows no context window for this model, so no limit is invented.
      expect(await screen.findByRole('button', { name: 'Context window: 12.3k tokens, limit unknown' })).toBeVisible();
      expect(screen.queryByRole('meter', { name: 'Context window' })).toBeNull();
    });
  });

  describe('in a Claude Agent session', () => {
    it('asks Claude Agent and never shows the observational-memory budgets', async () => {
      const session = stubPreparingSession();
      withObservationalMemory();
      claudeAgentSession(claudeTurn);
      const { client } = renderThread();
      await releaseSession(session.finishWorkspace, client);

      await waitFor(() => expect(messageBox().placeholder).toBe('Ask Claude Agent'));
      await screen.findByRole('button', { name: /^Context window/ });
      expect(screen.queryByRole('button', { name: /^Memory budgets:/ })).toBeNull();
      expect(screen.queryByText(/Claude Code/)).toBeNull();
    });

    it("meters the context from Factory's usage events against the window Claude Code reports", async () => {
      const session = stubPreparingSession();
      const factory = claudeAgentSession(claudeTurn);
      const { client } = renderThread();
      await releaseSession(session.finishWorkspace, client);

      expect(await screen.findByRole('meter', { name: 'Context window' })).toHaveAttribute(
        'aria-valuetext',
        '41.1/200k',
      );
      expect(screen.getByRole('button', { name: 'Context window: 41.1 of 200k' })).toBeVisible();

      // The next turn's report replaces it: the context is a snapshot, not a sum.
      factory.push(
        envelope(claudeTurn.length + 1, {
          type: 'usage',
          inputTokens: 12,
          outputTokens: 300,
          contextTokens: 185_000,
          contextWindow: 200_000,
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole('meter', { name: 'Context window' })).toHaveAttribute('aria-valuetext', '185/200k'),
      );
    });
  });

  describe('in a Claude Agent draft', () => {
    it('asks Claude Agent before the session exists', async () => {
      stubPreparingSession();
      server.use(
        http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/runtime`, () =>
          HttpResponse.json({ runtimeId: 'claude-agent' }),
        ),
      );
      renderDraft();

      await waitFor(() => expect(messageBox().placeholder).toBe('Ask Claude Agent'));
    });
  });
});
