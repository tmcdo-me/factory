// fork(claude-agent): reading a model's context window from an OpenAI-compatible `/v1/models` list.
import { describe, expect, it } from 'vitest';

import { contextWindowsFromModelList } from './custom-provider-models.js';

describe('contextWindowsFromModelList', () => {
  it("reads each server's own field for the window", () => {
    expect(
      contextWindowsFromModelList({
        object: 'list',
        data: [
          { id: 'openrouter-style', context_length: 200000, top_provider: { context_length: 100000 } },
          { id: 'vllm', object: 'model', max_model_len: 32768 },
          { id: 'lm-studio', max_context_length: 8192 },
          { id: 'litellm', max_input_tokens: 128000 },
          { id: 'top-provider-only', top_provider: { context_length: 65536 } },
          { id: 'llama-cpp', meta: { n_ctx: 16384, n_ctx_train: 262144 } },
          { id: 'as-text', context_window: '131072' },
        ],
      }),
    ).toEqual({
      'openrouter-style': 200000,
      vllm: 32768,
      'lm-studio': 8192,
      litellm: 128000,
      'top-provider-only': 65536,
      'llama-cpp': 16384,
      'as-text': 131072,
    });
  });

  it("never takes a model's training length, a missing or nonsense value, or a list that isn't one", () => {
    expect(
      contextWindowsFromModelList({
        data: [
          { id: 'trained-only', meta: { n_ctx_train: 262144 } },
          { id: 'plain', object: 'model', owned_by: 'self' },
          { id: 'zero', context_length: 0 },
          { id: 'fraction', context_length: 1.5 },
          { id: 'absurd', context_length: 1e12 },
          { context_length: 4096 },
        ],
      }),
    ).toEqual({});
    expect(contextWindowsFromModelList({ error: 'Missing API key' })).toEqual({});
    expect(contextWindowsFromModelList([{ id: 'bare-array', context_length: 4096 }])).toEqual({ 'bare-array': 4096 });
  });
});
