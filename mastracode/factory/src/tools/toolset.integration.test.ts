// fork(claude-agent): Factory's tool definitions in a real Mastra Code session (slice 4).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LLMock } from '@copilotkit/aimock';
import { defineFactoryTool } from '@factory/agent-runtime';
import type { FactoryToolContext } from '@factory/agent-runtime';
import { createMastraCode } from '@mastra/code-sdk';
import { setCredentialStoreProvider } from '@mastra/code-sdk/agents/credential-resolver';
import { EventEmitterPubSub } from '@mastra/core/events';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createTriageWorkRegistry } from '../boards/test-utils.js';
import { createFactoryReadTools } from './read-tools.js';
import type { FactoryReadToolDependencies } from './read-tools.js';
import type { FactoryToolScope } from './scope.js';
import { mastraCodeExtraTools } from './toolset.js';

vi.setConfig({ testTimeout: 60_000 });

const MODEL = 'gpt-5.4-mini';
let directory: string;
let mock: LLMock;
let stops: Array<() => Promise<void> | void>;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'factory-toolset-'));
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

describe('Factory tool definitions in a Mastra Code session', () => {
  it("run as the turn's session and caller, with the model's call id and the validated input", async () => {
    const scope: FactoryToolScope = {
      orgId: 'org-1',
      factoryProjectId: 'project-1',
      userId: 'user-1',
      sessionId: 's1',
      resourceId: 's1',
      threadId: 's1',
      kind: 'user',
      interactive: true,
    };
    const deps = {
      workItems: { listShared: async () => [], listRunBindings: async () => [] },
      audit: { list: async () => ({ events: [] }) },
      boards: createTriageWorkRegistry(),
    } as unknown as FactoryReadToolDependencies;
    const calls: { input: unknown; ctx: FactoryToolContext }[] = [];
    const probe = defineFactoryTool({
      name: 'factory_probe',
      description: 'Reports what a Factory tool sees',
      input: z.object({ item: z.string().trim() }).strict(),
      execute: async (input, ctx) => {
        calls.push({ input, ctx });
        return { seen: input.item };
      },
    });
    const built: RequestContext[] = [];

    mock.on(
      { sequenceIndex: 0 },
      {
        toolCalls: [
          { id: 'call_probe', name: 'factory_probe', arguments: JSON.stringify({ item: ' w1 ' }) },
          { id: 'call_list', name: 'factory_list_work_items', arguments: JSON.stringify({}) },
        ],
      },
    );
    mock.onMessage(/.*/, { content: 'Done.' });
    const settingsPath = path.join(directory, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        onboarding: { skippedAt: '2026-01-01T00:00:00.000Z', version: 1 },
        models: { activeModelPackId: null, modeDefaults: { build: `openai/${MODEL}`, plan: `openai/${MODEL}` } },
      }),
    );
    const code = await createMastraCode({
      cwd: directory,
      homeDir: directory,
      configDir: '.mastracode-test',
      settingsPath,
      storage: new LibSQLStore({ id: 'toolset', url: `file:${path.join(directory, 'mastra.db')}` }),
      storageBackend: 'libsql',
      pubsub: new EventEmitterPubSub(),
      disableMcp: true,
      disableHooks: true,
      disableEnvFile: true,
      disablePlugins: true,
      disableGithubSignals: true,
      createInitialThread: false,
      // As the Factory server builds them: per turn, from the turn's request context.
      extraTools: mastraCodeExtraTools(async ({ requestContext }) => {
        built.push(requestContext);
        return { factory_probe: probe, ...createFactoryReadTools(scope, deps) };
      }),
    });
    stops.push(() => code.controller.shutdown?.());

    const caller = () => new RequestContext([['user', { workosId: 'user-1', organizationId: 'org-1' }]]);
    const session = await code.controller.createSession({
      id: 's1',
      resourceId: 's1',
      threadId: 's1',
      ownerId: 'user-1',
      requestContext: caller(),
    });
    const ended: { toolCallId: string; result: unknown; isError?: boolean }[] = [];
    const errors: string[] = [];
    session.subscribe(event => {
      if (event.type === 'tool_end') ended.push(event as never);
      if (event.type === 'error') errors.push(event.error.message);
    });
    void session.sendMessage({ content: 'Look around.', requestContext: caller() }).catch(() => {});
    await vi.waitFor(() => expect(ended).toHaveLength(2), { timeout: 30_000 });

    expect(errors).toEqual([]);
    expect(built.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ item: 'w1' });
    expect(calls[0]!.ctx).toMatchObject({ sessionId: 's1', callId: 'call_probe', orgId: 'org-1', userId: 'user-1' });
    expect(calls[0]!.ctx.signal).toBeInstanceOf(AbortSignal);
    const byCall = Object.fromEntries(ended.map(event => [event.toolCallId, event]));
    expect(byCall.call_probe).toMatchObject({ result: { seen: 'w1' } });
    expect(byCall.call_probe?.isError).toBeFalsy();
    // A ported read tool answers as before.
    expect(byCall.call_list).toMatchObject({ result: { counts: { total: 0, byStage: {} }, items: [] } });
  });
});
