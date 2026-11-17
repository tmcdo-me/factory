/**
 * Factory tool definitions as Mastra Code's agent gets them: a real AgentController session (mock
 * model) calls an adapted definition, so the call's id, request context, approval and validated
 * input are the ones Mastra really passes.
 */
import { defineFactoryTool } from '@factory/agent-runtime';
import type { FactoryToolContext } from '@factory/agent-runtime';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { mastraTool } from './tools';
import type { MastraToolCall } from './tools';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

type DoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV2>[0]>['doStream'];
type StreamPart =
  Awaited<ReturnType<Extract<DoStream, (...args: never[]) => unknown>>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

function model(toolName: string, input: unknown) {
  const callTool: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ];
  const answer: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'Done.' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
  let calls = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      calls++;
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
        stream: convertArrayToReadableStream(calls === 1 ? callTool : answer),
      };
    },
  });
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  return check();
}

function contextOf(call: MastraToolCall): FactoryToolContext {
  const controller = call.requestContext?.get('controller') as { sessionId?: string } | undefined;
  return {
    sessionId: controller?.sessionId ?? 'none',
    callId: call.callId ?? 'none',
    orgId: 'org-1',
    userId: 'user-1',
    signal: call.signal ?? new AbortController().signal,
    interact: async () => {
      throw new Error('no human here');
    },
  };
}

describe('mastraTool on a real AgentController session', () => {
  it("runs the definition with Mastra's call id, the session's request context and the validated input, after approval", async () => {
    const seen: { input: unknown; ctx: FactoryToolContext }[] = [];
    const move = defineFactoryTool({
      name: 'factory_transition_work_item',
      description: 'Move the card',
      input: z.object({ stage: z.string().trim().min(1) }).strict(),
      approval: 'required',
      execute: async (input, ctx) => {
        seen.push({ input, ctx });
        return { moved: input.stage };
      },
    });
    const agent = new Agent({
      id: 'code',
      name: 'code',
      instructions: 'test',
      model: model('factory_transition_work_item', { stage: '  review ' }),
      tools: { [move.name]: mastraTool(move, contextOf) },
    });
    const controller = new AgentController({
      id: 'code',
      storage: new InMemoryStore(),
      workspace: new Workspace({ name: 'test', skills: ['/tmp/test-skills'] }),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    await controller.init();
    const session = await controller.createSession({ id: 's1', ownerId: 'o' });
    const native: AgentControllerEvent[] = [];
    session.subscribe(event => {
      native.push(event);
    });

    void session.sendMessage({ content: 'Ship it' });
    // `approval: 'required'` asks first, as `requireApproval` does.
    expect(await until(() => native.some(e => e.type === 'tool_approval_required'))).toBe(true);
    expect(seen).toEqual([]);
    session.respondToToolApproval({ decision: 'approve', toolCallId: 'call-1' });
    expect(await until(() => native.some(e => e.type === 'agent_end'))).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.input).toEqual({ stage: 'review' });
    expect(seen[0]!.ctx).toMatchObject({ sessionId: 's1', callId: 'call-1' });
    expect(seen[0]!.ctx.signal).toBeInstanceOf(AbortSignal);
    const ended = native.find(
      (e): e is Extract<AgentControllerEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && (e as { toolCallId?: string }).toolCallId === 'call-1',
    );
    expect(ended).toMatchObject({ result: { moved: 'review' } });
    await controller.destroy?.();
  });
});

describe('mastraTool', () => {
  it("answers a rejected input with Mastra's validation error, without running the definition", async () => {
    const execute = vi.fn(async () => 'ran');
    const tool = mastraTool(
      defineFactoryTool({ name: 'factory_strict', description: 'Strict', input: z.object({ n: z.number() }), execute }),
      contextOf,
    );
    expect(tool.id).toBe('factory_strict');
    expect(await tool.execute!({ n: 'one' } as never, {} as never)).toMatchObject({ error: true });
    expect(execute).not.toHaveBeenCalled();
    expect(await tool.execute!({ n: 1 } as never, {} as never)).toBe('ran');
  });

  it('keeps approval unset unless the definition sets it', () => {
    const def = { name: 'x', description: 'x', input: z.object({}), execute: async () => null };
    expect(mastraTool(def, contextOf).requireApproval).toBeFalsy();
    expect(mastraTool({ ...def, approval: 'none' }, contextOf).requireApproval).toBe(false);
    expect(mastraTool({ ...def, approval: 'required' }, contextOf).requireApproval).toBe(true);
  });
});
