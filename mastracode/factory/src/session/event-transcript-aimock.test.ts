// fork(claude-agent): slice 7. A finished tool call read from Factory's transcript names the same assistant
// message Mastra's memory keeps it in, so the board's rule ingress is the same whether the step or the
// transcript reads it. Real Mastra Code session, mock model.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LLMock } from '@copilotkit/aimock';
import { InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import { createMastraCode } from '@mastra/code-sdk';
import { setCredentialStoreProvider } from '@mastra/code-sdk/agents/credential-resolver';
import { EventEmitterPubSub } from '@mastra/core/events';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { observeSessionAgentEvents } from './agent-event-mirror.js';
import { listFinishedToolCalls } from './event-transcript-reader.js';

vi.setConfig({ testTimeout: 60_000 });

const MODEL = 'gpt-5.4-mini';
let directory: string;
let mock: LLMock;
let stops: Array<() => Promise<void> | void>;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'factory-transcript-'));
  mock = new LLMock({ port: 0 });
  await mock.start();
  vi.stubEnv('OPENAI_BASE_URL', `${mock.url.replace(/\/+$/, '')}/v1`);
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('MASTRA_APP_DATA_DIR', path.join(directory, 'app-data'));
  vi.stubEnv('MASTRACODE_DISABLE_UNIX_SOCKET_PUBSUB', '1');
  vi.stubEnv('MASTRACODE_DISABLE_OBSERVATIONAL_MEMORY', '1');
  setCredentialStoreProvider(() => ({
    allowEnvironmentFallback: false,
    reload: () => {},
    get: () => ({ type: 'api_key', key: 'test-key' }),
    getStoredApiKey: () => 'test-key',
    getApiKey: async () => 'test-key',
  }));
  stops = [];
});

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await mock.stop();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('the transcript of a Mastra Code session', () => {
  it('names a finished tool call in the assistant message and thread Mastra keeps it in', async () => {
    const settingsPath = path.join(directory, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        onboarding: { skippedAt: '2026-01-01T00:00:00.000Z', version: 1 },
        models: { activeModelPackId: null, modeDefaults: { build: `openai/${MODEL}`, plan: `openai/${MODEL}` } },
      }),
    );
    const store = new LibSQLStore({ id: 'transcript', url: `file:${path.join(directory, 'mastra.db')}` });
    const code = await createMastraCode({
      cwd: directory,
      homeDir: directory,
      configDir: '.mastracode-test',
      settingsPath,
      storage: store,
      storageBackend: 'libsql',
      pubsub: new EventEmitterPubSub(),
      disableMcp: true,
      disableHooks: true,
      disableEnvFile: true,
      disablePlugins: true,
      disableGithubSignals: true,
      createInitialThread: false,
      extraTools: {
        note_it: createTool({
          id: 'note_it',
          description: 'Take a note.',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ noted: text }),
        }),
      },
    });
    stops.push(() => code.controller.shutdown?.());
    let asked = 0;
    mock.on(
      {
        predicate: request => {
          if (!JSON.stringify(request).includes('You are Mastra Code')) return false;
          asked += 1;
          return asked === 1;
        },
      },
      { toolCalls: [{ id: 'call_note_1', name: 'note_it', arguments: JSON.stringify({ text: 'hi' }) }] },
    );
    mock.on({ predicate: () => true }, { content: 'Done.' });

    const log = new InMemoryEventLog();
    const hub = new SessionEventHub(log);
    const caller = () => new RequestContext([['user', { workosId: 'user-1', organizationId: 'org-1' }]]);
    const session = await code.controller.createSession({
      id: 's1',
      resourceId: 's1',
      threadId: 's1',
      ownerId: 'user-1',
      requestContext: caller(),
    });
    observeSessionAgentEvents(session, hub);
    let ends = 0;
    session.subscribe(event => {
      if (event.type === 'agent_end') ends += 1;
    });
    void session.sendMessage({ content: 'Take a note.', requestContext: caller() }).catch(() => {});
    await vi.waitFor(() => expect(ends).toBeGreaterThan(0), { timeout: 30_000 });
    await new Promise(r => setTimeout(r, 500));

    const memory = await store.getStore('memory');
    const persisted = (await memory!.listMessages({ threadId: 's1', resourceId: 's1', page: 0, perPage: 100 }))
      .messages;
    const holder = persisted.find(
      message =>
        JSON.stringify(message.content).includes('call_note_1') && JSON.stringify(message.content).includes('noted'),
    );
    expect(holder).toBeDefined();

    const read = await listFinishedToolCalls(log, { sessionId: 's1', threadId: 's1' });
    expect(read).toHaveLength(1);
    expect(read[0]!.id).toBe(holder!.id);
    expect(JSON.stringify(read[0]!.content)).toContain('call_note_1');

    // Another thread's runs are not this binding's.
    expect(await listFinishedToolCalls(log, { sessionId: 's1', threadId: 'other' })).toEqual([]);
  });
});
