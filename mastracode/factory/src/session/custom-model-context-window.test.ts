// fork(claude-agent): the context meter knows a self-hosted model's window (a custom OpenAI-compatible provider).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LLMock } from '@copilotkit/aimock';
import { buildTranscript, InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import { createMastraCode } from '@mastra/code-sdk';
import { EventEmitterPubSub } from '@mastra/core/events';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigRoutes } from '../routes/config.js';
import {
  primeCustomProvidersForRequestContext,
  registerCustomProvidersSource,
  resetCustomProvidersSourceForTests,
} from '../routes/custom-provider-source.js';
import { fakeRouteAuth, mountApiRoutes } from '../routes/test-utils.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { FactoryStorageTestSeed } from '../storage/test-utils.js';
import { observeSessionAgentEvents, sessionModelContextWindow } from './agent-event-mirror.js';

vi.setConfig({ testTimeout: 60_000 });

const MODEL = 'qwen3.8-27b';

let directory: string;
let mock: LLMock;
let seed: FactoryStorageTestSeed;
let stops: Array<() => Promise<void> | void>;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'factory-context-window-'));
  mock = new LLMock({ port: 0 });
  await mock.start();
  vi.stubEnv('MASTRA_APP_DATA_DIR', path.join(directory, 'app-data'));
  vi.stubEnv('MASTRACODE_DISABLE_UNIX_SOCKET_PUBSUB', '1');
  vi.stubEnv('MASTRACODE_DISABLE_OBSERVATIONAL_MEMORY', '1');
  seed = await createFactoryStorageForTests();
  // No auth: every custom provider is the local org's, as on a single-user Factory.
  registerCustomProvidersSource({ storage: seed.customProviders, authEnabled: false });
  stops = [];
});

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  resetCustomProvidersSourceForTests();
  await mock.stop();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/** The Settings form's save, through the real config route. */
async function saveProvider(body: Record<string, unknown>) {
  const app = new Hono();
  mountApiRoutes(
    app as never,
    new ConfigRoutes({
      auth: fakeRouteAuth({ enabled: false }),
      controller: { listAvailableModels: async () => [] } as never,
      customProviders: seed.customProviders,
      onCustomProvidersChanged: () => {},
    }).routes(),
  );
  const response = await app.request('/web/config/custom-providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/**
 * A self-hosted OpenAI-compatible server: `/v1/models` says what it serves (and, when `reports`, each
 * model's context length); everything else goes to the mock model.
 */
async function selfHostedProvider(initial?: number) {
  const seen: IncomingHttpHeaders[] = [];
  const state: { reports?: number; down: boolean } = { reports: initial, down: false };
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      seen.push(request.headers);
      if (state.down) {
        response.statusCode = 503;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: MODEL,
              object: 'model',
              owned_by: 'self',
              ...(state.reports ? { context_length: state.reports } : {}),
            },
          ],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const upstream = await fetch(`${mock.url.replace(/\/+$/, '')}${request.url}`, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    response.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key !== 'content-length' && key !== 'content-encoding' && key !== 'transfer-encoding')
        response.setHeader(key, value);
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, state };
}

/** A Mastra Code session on the provider's model, mirrored into Factory's event log as the server does. */
async function sessionOnCustomModel(modelId: string) {
  const settingsPath = path.join(directory, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      onboarding: { skippedAt: '2026-01-01T00:00:00.000Z', version: 1 },
      models: { activeModelPackId: null, modeDefaults: { build: modelId, plan: modelId } },
    }),
  );
  // The prompt's size is what the meter fills against the window.
  mock.onMessage(/.*/, {
    content: 'Hello from the self-hosted model.',
    usage: { prompt_tokens: 4096, completion_tokens: 8, total_tokens: 4104 },
  });
  const code = await createMastraCode({
    cwd: directory,
    homeDir: directory,
    configDir: '.mastracode-test',
    settingsPath,
    storage: new LibSQLStore({ id: 'context-window', url: `file:${path.join(directory, 'mastra.db')}` }),
    storageBackend: 'libsql',
    pubsub: new EventEmitterPubSub(),
    disableMcp: true,
    disableHooks: true,
    disableEnvFile: true,
    disablePlugins: true,
    disableGithubSignals: true,
    createInitialThread: false,
  });
  stops.push(() => code.controller.shutdown?.());
  const requestContext = new RequestContext();
  await primeCustomProvidersForRequestContext(requestContext);
  const session = await code.controller.createSession({
    id: 'session-1',
    resourceId: 'session-1',
    threadId: 'session-1',
    ownerId: 'local',
    requestContext,
  });
  const log = new InMemoryEventLog();
  observeSessionAgentEvents(session, new SessionEventHub(log), { contextWindow: sessionModelContextWindow(session) });
  const errors: string[] = [];
  session.subscribe(event => {
    if (event.type === 'error') errors.push(event.error.message);
  });
  await session.sendMessage({ content: 'Say hello.', requestContext });
  await vi.waitFor(async () => expect((await log.list('session-1')).some(e => e.event.type === 'usage')).toBe(true), {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
  return buildTranscript('session-1', await log.list('session-1'));
}

describe('the context meter on a self-hosted model', () => {
  it('reports the window set in Settings with each model call, so the meter has a limit', async () => {
    const provider = await selfHostedProvider();
    const saved = await saveProvider({
      name: 'Self Hosted',
      url: provider.url,
      apiKey: 'sk-self-hosted',
      models: [MODEL],
      contextWindows: { [MODEL]: 131072 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.provider).toMatchObject({
      id: 'self-hosted',
      contextWindows: { [MODEL]: { tokens: 131072, source: 'set' } },
    });

    const transcript = await sessionOnCustomModel(`self-hosted/${MODEL}`);

    expect(transcript.usage).toMatchObject({ contextWindow: 131072, contextTokens: 4096 });
  });

  it("takes the window the provider's model list reports when none is set, asking with the provider's key", async () => {
    const provider = await selfHostedProvider(262144);
    const saved = await saveProvider({
      name: 'Self Hosted',
      url: provider.url,
      apiKey: 'sk-self-hosted',
      models: [MODEL],
    });
    expect(saved.body.provider).toMatchObject({ contextWindows: { [MODEL]: { tokens: 262144, source: 'reported' } } });
    expect(provider.seen.map(headers => headers.authorization)).toEqual(['Bearer sk-self-hosted']);

    // An id saved from the shared catalog in its gateway-qualified form finds the same window.
    const transcript = await sessionOnCustomModel(`mastracode/self-hosted/${MODEL}`);

    expect(transcript.usage).toMatchObject({ contextWindow: 262144 });
  });

  it('keeps the stored key when the form is saved again without one, and a hand-set window wins over the reported one', async () => {
    const provider = await selfHostedProvider(262144);
    await saveProvider({ name: 'Self Hosted', url: provider.url, apiKey: 'sk-self-hosted', models: [MODEL] });

    const edited = await saveProvider({
      name: 'Self Hosted',
      url: provider.url,
      models: [MODEL],
      contextWindows: { [MODEL]: 32768 },
      previousId: 'self-hosted',
    });

    expect(edited.body.provider).toMatchObject({
      hasApiKey: true,
      contextWindows: { [MODEL]: { tokens: 32768, source: 'set' } },
    });
    const [stored] = await seed.customProviders.list({ orgId: 'local' });
    expect(stored).toMatchObject({ apiKey: 'sk-self-hosted' });
  });

  it("never sends the stored key to a URL it wasn't given for: an edit that moves the provider must re-enter it", async () => {
    const provider = await selfHostedProvider(262144);
    await saveProvider({ name: 'Self Hosted', url: provider.url, apiKey: 'sk-self-hosted', models: [MODEL] });
    const elsewhere = await selfHostedProvider(262144);

    const moved = await saveProvider({
      name: 'Self Hosted',
      url: elsewhere.url,
      models: [MODEL],
      previousId: 'self-hosted',
    });

    expect(moved).toEqual({ status: 400, body: { error: 'Re-enter the API key when changing the URL.' } });
    expect(elsewhere.seen).toEqual([]);
    const [stored] = await seed.customProviders.list({ orgId: 'local' });
    expect(stored).toMatchObject({ url: provider.url, apiKey: 'sk-self-hosted' });

    // With the key typed again, it moves.
    const retyped = await saveProvider({
      name: 'Self Hosted',
      url: elsewhere.url,
      apiKey: 'sk-elsewhere',
      models: [MODEL],
      previousId: 'self-hosted',
    });
    expect(retyped.status).toBe(200);
    expect(elsewhere.seen.map(headers => headers.authorization)).toEqual(['Bearer sk-elsewhere']);
  });

  it("gives a new provider whose name matches another's id none of its key", async () => {
    const provider = await selfHostedProvider();
    await saveProvider({ name: 'Self Hosted', url: provider.url, apiKey: 'sk-self-hosted', models: [MODEL] });

    const created = await saveProvider({ name: 'self hosted', url: provider.url, models: [MODEL] });

    expect(created.body.provider).toMatchObject({ id: 'self-hosted', hasApiKey: false });
    expect(provider.seen.at(-1)?.authorization).toBeUndefined();
  });

  it('removes the stored key when asked to, and refuses a key and a removal together', async () => {
    const provider = await selfHostedProvider();
    await saveProvider({ name: 'Self Hosted', url: provider.url, apiKey: 'sk-self-hosted', models: [MODEL] });

    const both = await saveProvider({
      name: 'Self Hosted',
      url: provider.url,
      apiKey: 'sk-new',
      clearApiKey: true,
      models: [MODEL],
      previousId: 'self-hosted',
    });
    expect(both.status).toBe(400);

    const cleared = await saveProvider({
      name: 'Self Hosted',
      url: provider.url,
      clearApiKey: true,
      models: [MODEL],
      previousId: 'self-hosted',
    });
    expect(cleared.body.provider).toMatchObject({ hasApiKey: false });
    const [stored] = await seed.customProviders.list({ orgId: 'local' });
    expect(stored?.apiKey).toBeNull();
  });

  it('reads a reported window again on every save, and keeps the last one while the list is unreachable', async () => {
    const provider = await selfHostedProvider(262144);
    const edit = () =>
      saveProvider({ name: 'Self Hosted', url: provider.url, models: [MODEL], previousId: 'self-hosted' });
    await saveProvider({ name: 'Self Hosted', url: provider.url, apiKey: 'sk-self-hosted', models: [MODEL] });

    provider.state.reports = 131072;
    expect((await edit()).body.provider).toMatchObject({
      contextWindows: { [MODEL]: { tokens: 131072, source: 'reported' } },
    });

    provider.state.down = true;
    expect((await edit()).body.provider).toMatchObject({
      contextWindows: { [MODEL]: { tokens: 131072, source: 'reported' } },
    });
  });

  it('leaves the window out for a model nothing sets one for, so the meter shows tokens alone', async () => {
    const provider = await selfHostedProvider();
    await saveProvider({ name: 'Self Hosted', url: provider.url, apiKey: 'sk-self-hosted', models: [MODEL] });

    const transcript = await sessionOnCustomModel(`self-hosted/${MODEL}`);

    expect(transcript.usage?.contextTokens).toBe(4096);
    expect(transcript.usage).not.toHaveProperty('contextWindow');
  });

  it('refuses a window that is not a whole number of tokens', async () => {
    const provider = await selfHostedProvider();
    const saved = await saveProvider({
      name: 'Self Hosted',
      url: provider.url,
      models: [MODEL],
      contextWindows: { [MODEL]: 'lots' },
    });
    expect(saved.status).toBe(400);
  });
});
