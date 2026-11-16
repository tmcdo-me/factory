// fork(claude-agent)
import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FactoryEvent } from '@factory/agent-runtime';
import { describe, expect, it } from 'vitest';

import { ClaudeAgentEventMapper } from './event-mapper';

const base = { session_id: 'claude-1', uuid: '00000000-0000-0000-0000-000000000000' } as const;

const init = (model: string) =>
  ({ ...base, type: 'system', subtype: 'init', model, cwd: '/w', tools: [] }) as unknown as SDKMessage;

interface CallUsage {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

/** A model call's opening stream event, which carries the prompt's usage. */
const messageStart = (id: string, model: string, usage: CallUsage, parent: string | null = null) =>
  ({
    ...base,
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_start', message: { id, model, usage } },
  }) as unknown as SDKMessage;

/** A full assistant message (not streamed), with its own usage. */
const assistant = (id: string, model: string, usage: CallUsage, parent: string | null = null) =>
  ({
    ...base,
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
  }) as unknown as SDKMessage;

const modelUsage = (contextWindow: number, extra: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow,
  maxOutputTokens: 64_000,
  ...extra,
});

const result = (models?: Record<string, ModelUsage>) =>
  ({
    ...base,
    type: 'result',
    subtype: 'success',
    result: 'done',
    total_cost_usd: 0.05,
    // The turn's totals: two calls, so the shared prefix is counted twice.
    usage: { input_tokens: 30, output_tokens: 900, cache_read_input_tokens: 81_000, cache_creation_input_tokens: 600 },
    ...(models ? { modelUsage: models } : {}),
  }) as unknown as SDKMessage;

function usageOf(events: FactoryEvent[]) {
  const usage = events.find(event => event.type === 'usage');
  if (!usage || usage.type !== 'usage') throw new Error('no usage event');
  return usage;
}

describe('ClaudeAgentEventMapper usage', () => {
  it("reports the main agent's last prompt as the context, not the turn's totals", () => {
    const mapper = new ClaudeAgentEventMapper();
    mapper.map(init('claude-opus-5-5'));
    mapper.map(
      messageStart('msg_1', 'claude-opus-5-5', {
        input_tokens: 10,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 500,
      }),
    );
    // A subagent's call has its own context and must not replace the main agent's.
    mapper.map(assistant('msg_sub', 'claude-haiku-5-5', { input_tokens: 90_000 }, 'toolu_task'));
    mapper.map(
      messageStart('msg_2', 'claude-opus-5-5', {
        input_tokens: 20,
        cache_read_input_tokens: 41_000,
        cache_creation_input_tokens: 100,
      }),
    );

    const usage = usageOf(
      mapper.map(
        result({
          'claude-opus-5-5': modelUsage(200_000),
          'claude-haiku-5-5': modelUsage(100_000),
        }),
        { runId: 'r1' },
      ),
    );

    expect(usage).toEqual({
      type: 'usage',
      runId: 'r1',
      inputTokens: 30,
      outputTokens: 900,
      cachedInputTokens: 81_000,
      costUsd: 0.05,
      contextTokens: 41_120,
      contextWindow: 200_000,
    });
  });

  it('reads the context from a full assistant message when the call was not streamed', () => {
    const mapper = new ClaudeAgentEventMapper();
    mapper.map(init('claude-sonnet-5-5'));
    mapper.map(assistant('msg_1', 'claude-sonnet-5-5', { input_tokens: 1_200, cache_read_input_tokens: 3_000 }));

    const usage = usageOf(mapper.map(result({ 'claude-sonnet-5-5': modelUsage(1_000_000) })));

    expect(usage).toMatchObject({ contextTokens: 4_200, contextWindow: 1_000_000 });
  });

  it("finds the window by the model's canonical id, or the only model reported", () => {
    const byCanonical = new ClaudeAgentEventMapper();
    byCanonical.map(init('claude-opus-5-5'));
    expect(
      usageOf(
        byCanonical.map(
          result({
            'opus[1m]': modelUsage(1_000_000, { canonicalModel: 'claude-opus-5-5' }),
            'claude-haiku-5-5': modelUsage(100_000),
          }),
        ),
      ),
    ).toMatchObject({ contextWindow: 1_000_000 });

    const onlyOne = new ClaudeAgentEventMapper();
    onlyOne.map(init('opus'));
    expect(usageOf(onlyOne.map(result({ 'claude-opus-5-5': modelUsage(200_000) })))).toMatchObject({
      contextWindow: 200_000,
    });
  });

  it('leaves the window out rather than guess between several models, and both out with no call', () => {
    const mapper = new ClaudeAgentEventMapper();
    mapper.map(init('opus'));

    const usage = usageOf(
      mapper.map(result({ 'claude-opus-5-5': modelUsage(200_000), 'claude-haiku-5-5': modelUsage(100_000) })),
    );

    expect(usage).not.toHaveProperty('contextWindow');
    expect(usage).not.toHaveProperty('contextTokens');
  });

  it('keeps working without modelUsage (older Claude Code)', () => {
    const mapper = new ClaudeAgentEventMapper();
    mapper.map(messageStart('msg_1', 'claude-opus-5-5', { input_tokens: 5 }));

    const usage = usageOf(mapper.map(result()));

    expect(usage).toMatchObject({ contextTokens: 5 });
    expect(usage).not.toHaveProperty('contextWindow');
  });
});
