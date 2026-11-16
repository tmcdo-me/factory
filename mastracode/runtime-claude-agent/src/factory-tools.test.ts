import { defineFactoryTool } from '@factory/agent-runtime';
import type { FactoryToolContext } from '@factory/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createFactoryMcpServer, factoryMcpToolNames } from './factory-tools';
import type { FactoryToolCall } from './factory-tools';
import { mcpClient } from './test-utils';

const move = defineFactoryTool({
  name: 'factory_transition_work_item',
  description: 'Move the card',
  input: z.object({ stage: z.string().regex(/^[a-z]+$/), rationale: z.string().trim().min(1) }).strict(),
  execute: async (input, ctx) => ({ moved: input.stage, rationale: input.rationale, by: ctx.userId }),
});
const broken = defineFactoryTool({
  name: 'factory_broken',
  description: 'Always fails',
  input: z.object({}),
  execute: async () => {
    throw new Error('Bound Factory work item not found.');
  },
});

function contextFor(call: FactoryToolCall): FactoryToolContext {
  return {
    sessionId: 's1',
    callId: call.callId,
    orgId: 'org-1',
    userId: 'user-1',
    workspace: {} as FactoryToolContext['workspace'],
    signal: call.signal,
    interact: async () => {
      throw new Error('no human here');
    },
  };
}

describe('createFactoryMcpServer', () => {
  it("lists Factory's tools under the `factory` server with their own schemas, never deferred", async () => {
    const server = createFactoryMcpServer(
      { defs: [move, broken], context: contextFor },
      { currentRunId: () => 'run-1', newId: () => 'id' },
    );
    expect(server).toMatchObject({ type: 'sdk', name: 'factory' });
    const tools = await (await mcpClient(server)).listTools();
    expect(tools.map(tool => tool.name)).toEqual(['factory_transition_work_item', 'factory_broken']);
    expect(tools[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { stage: { type: 'string', pattern: '^[a-z]+$' }, rationale: { type: 'string', minLength: 1 } },
      required: ['stage', 'rationale'],
      additionalProperties: false,
    });
    expect(tools[0]).toMatchObject({ _meta: { 'anthropic/alwaysLoad': true } });
    expect(factoryMcpToolNames([move])).toEqual(['mcp__factory__factory_transition_work_item']);
  });

  it("runs a call with the context Factory binds for Claude's tool_use and the current run", async () => {
    const context = vi.fn(contextFor);
    const server = createFactoryMcpServer(
      { defs: [move], context },
      { currentRunId: () => 'run-7', newId: () => 'id' },
    );
    const result = await (
      await mcpClient(server)
    ).call('factory_transition_work_item', { stage: 'build', rationale: '  ready  ' }, 'toolu_move');

    expect(context).toHaveBeenCalledWith(expect.objectContaining({ callId: 'toolu_move', runId: 'run-7' }));
    expect(context.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ moved: 'build', rationale: 'ready', by: 'user-1' });
  });

  it('reports a failing tool and a rejected input as tool errors Claude can read', async () => {
    const server = createFactoryMcpServer(
      { defs: [move, broken], context: contextFor },
      { currentRunId: () => undefined, newId: () => 'generated' },
    );
    const client = await mcpClient(server);
    expect(await client.call('factory_broken', {})).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Bound Factory work item not found.' }],
    });
    const invalid = await client.call('factory_transition_work_item', { stage: 'Build!', rationale: 'x' });
    expect(invalid.isError).toBe(true);
  });
});
