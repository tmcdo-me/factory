// fork(claude-agent): reading a model's context window from an OpenAI-compatible `/v1/models` list.
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { contextWindowsFromModelList, modelsUrl, readProviderContextWindows } from './custom-provider-models.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function serve(handler: RequestListener) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, hits };
}

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

describe('readProviderContextWindows', () => {
  it("asks the provider's own models URL, keeping its query", () => {
    expect(modelsUrl('https://llm.example.com/v1')).toBe('https://llm.example.com/v1/models');
    expect(modelsUrl('https://llm.example.com/v1/?api-version=2')).toBe(
      'https://llm.example.com/v1/models?api-version=2',
    );
  });

  it('reads nothing from a body past 1 MB', async () => {
    const provider = await serve((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'm', context_length: 4096 }], padding: 'x'.repeat(1_100_000) }));
    });
    await expect(readProviderContextWindows({ url: provider.url, models: ['m'] })).resolves.toBeUndefined();
  });

  it('never follows a redirect, so the key never reaches another host', async () => {
    const elsewhere = await serve((_request, response) => response.end('{"data":[]}'));
    const provider = await serve((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', `${elsewhere.url}/models`);
      response.end();
    });
    await expect(
      readProviderContextWindows({ url: provider.url, apiKey: 'sk-x', models: ['m'] }),
    ).resolves.toBeUndefined();
    expect(elsewhere.hits).toEqual([]);
  });

  it('gives up on a provider that does not answer in time', async () => {
    const provider = await serve(() => {});
    await expect(
      readProviderContextWindows({ url: provider.url, models: ['m'], timeoutMs: 100 }),
    ).resolves.toBeUndefined();
  });
});
