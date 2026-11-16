/**
 * Drives a real Mastra AgentController session (mock model) and checks that the mirrored
 * FactoryEvent stream folds into the transcript Factory expects. Guards the mapper against drift
 * in Mastra's real event sequence, which hand-written fixtures can't.
 */
import { buildTranscript } from '@factory/agent-runtime';
import type { EventEnvelope, FactoryEvent } from '@factory/agent-runtime';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Workspace } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mirrorSessionEvents } from './mirror';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

type DoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV2>[0]>['doStream'];
type StreamPart =
  Awaited<ReturnType<Extract<DoStream, (...args: never[]) => unknown>>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

/** Step 1: think, talk, then call `factory_transition_work_item`. */
const firstStep: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'reasoning-start', id: 'r' },
  { type: 'reasoning-delta', id: 'r', delta: 'Card is ready.' },
  { type: 'reasoning-end', id: 'r' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Moving it ' },
  { type: 'text-delta', id: 't1', delta: 'to review.' },
  { type: 'text-end', id: 't1' },
  {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'factory_transition_work_item',
    input: JSON.stringify({ stage: 'review' }),
  },
  { type: 'finish', finishReason: 'tool-calls', usage },
];

/** Step 2: answer. */
const secondStep: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't2' },
  { type: 'text-delta', id: 't2', delta: 'Done.' },
  { type: 'text-end', id: 't2' },
  { type: 'finish', finishReason: 'stop', usage },
];

function model() {
  let calls = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      calls++;
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
        stream: convertArrayToReadableStream(calls === 1 ? firstStep : secondStep),
      };
    },
  });
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  return check();
}

describe('mirrorSessionEvents on a real AgentController session', () => {
  it('produces a transcript with the run, messages, the approved Factory tool call and its interaction', async () => {
    const transition = createTool({
      id: 'factory_transition_work_item',
      description: 'Move the card',
      inputSchema: z.object({ stage: z.string() }),
      requireApproval: true,
      execute: async ({ stage }) => ({ moved: true, stage }),
    });
    const agent = new Agent({ id: 'code', name: 'code', instructions: 'test', model: model(), tools: { transition } });
    const controller = new AgentController({
      id: 'code',
      storage: new InMemoryStore(),
      workspace: new Workspace({ name: 'test', skills: ['/tmp/test-skills'] }),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    await controller.init();
    const session = await controller.createSession({ id: 's1', ownerId: 'o' });

    const mirrored: FactoryEvent[] = [];
    const native: AgentControllerEvent[] = [];
    session.subscribe(event => {
      native.push(event);
    });
    const errors: unknown[] = [];
    mirrorSessionEvents(session, event => mirrored.push(event), { onError: error => errors.push(error) });

    void session.sendMessage({ content: 'Ship it' });
    expect(await until(() => native.some(e => e.type === 'tool_approval_required'))).toBe(true);
    session.respondToToolApproval({ decision: 'approve', toolCallId: 'call-1' });
    expect(await until(() => mirrored.some(e => e.type === 'run.ended' && e.reason === 'complete'))).toBe(true);

    // Set DUMP_EVENTS=1 to print Mastra's native event sequence when this test drifts.
    if (process.env.DUMP_EVENTS)
      console.log(
        native
          .filter(e => e.type !== 'display_state_changed')
          .map(e => JSON.stringify(e))
          .join('\n'),
      );
    expect(errors).toEqual([]);
    const envelopes: EventEnvelope[] = mirrored.map((event, i) => ({ sessionId: 's1', seq: i + 1, at: 't', event }));
    const transcript = buildTranscript('s1', envelopes);
    const byKind = (kind: string) => transcript.items.filter(item => item.kind === kind);

    expect(byKind('message')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'Ship it' }] }),
        expect.objectContaining({
          role: 'assistant',
          parts: expect.arrayContaining([{ type: 'text', text: expect.stringContaining('Moving it to review.') }]),
        }),
      ]),
    );
    const assistantText = byKind('message')
      .flatMap(item => (item.kind === 'message' && item.role === 'assistant' ? item.parts : []))
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join(' ');
    expect(assistantText).toContain('Done.');

    expect(byKind('tool')).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        name: 'factory_transition_work_item',
        category: 'factory',
        executor: 'factory',
        input: { stage: 'review' },
        status: 'done',
      }),
    ]);
    expect(byKind('interaction')).toEqual([
      expect.objectContaining({
        status: 'resolved',
        interaction: expect.objectContaining({ request: expect.objectContaining({ kind: 'tool_approval' }) }),
        response: { kind: 'tool_approval', approved: true },
      }),
    ]);
    const runs = byKind('run');
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.at(-1)).toMatchObject({ status: 'complete' });
    expect(mirrored.some(e => e.type === 'usage')).toBe(true);

    await controller.destroy?.();
  });
});
