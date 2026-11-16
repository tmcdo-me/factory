/**
 * Session commands against a real Mastra + AgentController (mock model): they reach the session
 * through Mastra's own agent-controller route handlers, and the mirrored events show the effect.
 */
import type { FactoryEvent } from '@factory/agent-runtime';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Workspace } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMastraCodeSessionCommands } from './commands';
import { mirrorSessionEvents } from './mirror';

type DoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV2>[0]>['doStream'];
type StreamPart =
  Awaited<ReturnType<Extract<DoStream, (...args: never[]) => unknown>>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const callTransition: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-1', toolName: 'transition', input: '{}' },
  { type: 'finish', finishReason: 'tool-calls', usage },
];
const answer = (text: string): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: 'stop', usage },
];

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  return check();
}

async function setup(steps: StreamPart[][]) {
  let calls = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: convertArrayToReadableStream(steps[Math.min(calls++, steps.length - 1)]!),
    }),
  });
  const transition = createTool({
    id: 'transition',
    description: 'Move the card',
    inputSchema: z.object({}),
    requireApproval: true,
    execute: async () => ({ moved: true }),
  });
  const agent = new Agent({ id: 'code', name: 'code', instructions: 'test', model, tools: { transition } });
  const controller = new AgentController({
    id: 'code',
    storage: new InMemoryStore(),
    workspace: new Workspace({ name: 'test', skills: ['/tmp/test-skills'] }),
    modes: [{ id: 'default', name: 'Default', default: true, agent }],
  });
  const mastra = new Mastra({ agentControllers: { code: controller }, logger: false });
  await controller.init();
  const session = await controller.createSession({ id: 's1', ownerId: 'o' });
  const events: FactoryEvent[] = [];
  mirrorSessionEvents(session, event => events.push(event));
  const commands = createMastraCodeSessionCommands({ mastra: () => mastra, controllerId: 'code' });
  const request = { context: new RequestContext() };
  return { commands, events, request, session, controller };
}

describe('createMastraCodeSessionCommands', () => {
  it('sends a message through the agent-controller handler', async () => {
    const { commands, events, request, controller } = await setup([answer('Hello back')]);

    expect(await commands.send('s1', { text: 'Hello' }, request)).toEqual({ ok: true });
    expect(await until(() => events.some(e => e.type === 'run.ended'))).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message.delta', part: 'text', delta: 'Hello back' }),
    );
    await controller.destroy?.();
  });

  it('answers a pending approval by its tool call, and reports a second answer as not pending', async () => {
    const { commands, events, request, controller } = await setup([callTransition, answer('Moved.')]);

    await commands.send('s1', { text: 'Move it' }, request);
    expect(await until(() => events.some(e => e.type === 'interaction.requested'))).toBe(true);

    const approve = { kind: 'tool_approval', approved: true } as const;
    expect(await commands.answer('s1', { interactionId: 'tool_approval:call-1' }, approve, request)).toEqual({
      ok: true,
    });
    expect(await until(() => events.some(e => e.type === 'tool.ended'))).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'interaction.resolved', response: { kind: 'tool_approval', approved: true } }),
    );
    expect(await until(() => events.some(e => e.type === 'run.ended' && e.reason === 'complete'))).toBe(true);

    const again = await commands.answer('s1', { callId: 'call-1' }, approve, request);
    expect(again.ok).toBe(false);
    await controller.destroy?.();
  });

  it('aborts, rejects an unaddressed answer, and reports an unknown session', async () => {
    const { commands, request, controller } = await setup([answer('x')]);

    expect(await commands.abort('s1', request)).toEqual({ ok: true });
    expect(await commands.answer('s1', {}, { kind: 'question', answer: 'a' }, request)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await commands.send('nope', { text: 'hi' }, request)).toMatchObject({
      ok: false,
      reason: 'session_not_found',
    });
    await controller.destroy?.();
  });
});
