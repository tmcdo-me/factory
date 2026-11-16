// fork(claude-agent): a custom OpenAI-compatible provider reports token usage on streamed replies.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The gateway binds its auth.json path at import time; keep it away from the developer's real one.
vi.hoisted(() => {
  process.env.MASTRA_APP_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/mastracode-gateway-usage-${process.pid}-${Date.now()}`;
});

import { MastraCodeGateway } from './mastracode-gateway.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});
afterAll(() => vi.unstubAllEnvs());

/** A self-hosted chat server that streams a reply, with usage only when asked for (as the spec says). */
async function chatServer({ refusesStreamOptions = false } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    bodies.push(body);
    if (refusesStreamOptions && 'stream_options' in body) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
      return;
    }
    const wantsUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
    response.setHeader('content-type', 'text/event-stream');
    const frame = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
    const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3.8-27b' };
    frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] });
    frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (wantsUsage)
      frame({ ...base, choices: [], usage: { prompt_tokens: 4096, completion_tokens: 2, total_tokens: 4098 } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

async function streamFrom(url: string) {
  const gateway = new MastraCodeGateway({
    mastraGatewayBaseUrl: 'https://gateway.example.com',
    routeThroughMastraGateway: false,
    customProviders: [{ name: 'Self Hosted', url, apiKey: 'sk-self', models: ['qwen3.8-27b'] }],
    settingsPath: join(process.env.MASTRA_APP_DATA_DIR!, 'settings.json'),
  });
  const model = gateway.resolveLanguageModel({ providerId: 'self-hosted', modelId: 'qwen3.8-27b', apiKey: 'sk-self' });
  const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  const parts: Array<{ type: string; usage?: { inputTokens?: unknown } }> = [];
  for await (const part of stream as AsyncIterable<{ type: string; usage?: { inputTokens?: unknown } }>)
    parts.push(part);
  return parts;
}

describe('a custom provider streaming a reply', () => {
  it('asks for usage, so the reply reports its prompt tokens', async () => {
    const server = await chatServer();
    const parts = await streamFrom(server.url);
    expect(server.bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(parts.find(part => part.type === 'finish')?.usage?.inputTokens).toMatchObject({ total: 4096 });
  });

  it('asks again without the option when the server refuses it by name, and the reply still streams', async () => {
    const server = await chatServer({ refusesStreamOptions: true });
    const parts = await streamFrom(server.url);
    expect(server.bodies.map(body => 'stream_options' in body)).toEqual([true, false]);
    expect(parts.some(part => part.type === 'text-delta')).toBe(true);

    // That provider is asked without it from then on.
    await streamFrom(server.url);
    expect(server.bodies.map(body => 'stream_options' in body)).toEqual([true, false, false]);
  });
});
