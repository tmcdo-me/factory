import { describe, expect, it } from 'vitest';

import { RuntimeRegistry } from './registry';
import type { AgentRuntime } from './runtime';

const runtime = (id: string): AgentRuntime => ({
  id,
  label: id,
  capabilities: { sandboxes: ['local'], subagents: false, thinkingLevels: [] },
  listModels: async () => [],
  openSession: async () => {
    throw new Error('not used');
  },
});

describe('RuntimeRegistry', () => {
  it('defaults to the first runtime and resolves by id', () => {
    const registry = new RuntimeRegistry([runtime('mastra-code'), runtime('claude-agent')]);
    expect(registry.defaultRuntimeId).toBe('mastra-code');
    expect(registry.require().id).toBe('mastra-code');
    expect(registry.require('claude-agent').id).toBe('claude-agent');
  });

  it('rejects duplicates, unknown defaults and unknown ids', () => {
    expect(() => new RuntimeRegistry([runtime('a'), runtime('a')])).toThrow(/Duplicate/);
    expect(() => new RuntimeRegistry([runtime('a')], { defaultRuntimeId: 'b' })).toThrow(/not registered/);
    expect(() => new RuntimeRegistry([runtime('a')]).require('b')).toThrow(/Unknown agent runtime "b". Enabled: a/);
  });
});
