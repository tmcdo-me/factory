// fork(claude-agent): slice 6i. What a Mastra Code session's model reads of Factory's context (the
// environment, `factory-phase` and `factory-work-item`), on a real Mastra Code server driven by a mock
// model. Pins the model-visible text per turn: the first turn carries each block, a changed card adds
// an update, an unchanged turn adds nothing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LLMock } from '@copilotkit/aimock';
import { createMastraCode } from '@mastra/code-sdk';
import { setCredentialStoreProvider } from '@mastra/code-sdk/agents/credential-resolver';
import { EventEmitterPubSub } from '@mastra/core/events';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTriageWorkRegistry } from '../boards/test-utils.js';
import { FactoryPhaseStateProcessor } from '../rules/processor.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import {
  FactoryEnvironmentStateProcessor,
  __clearSessionEnvironmentsForTests,
  recordSessionEnvironment,
} from './environment-state-processor.js';
import { FactoryWorkItemStateProcessor } from './work-item-state-processor.js';

vi.setConfig({ testTimeout: 60_000 });

const MODEL = 'gpt-5.4-mini';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
let directory: string;
let mock: LLMock;
let stops: Array<() => Promise<void> | void>;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'factory-context-'));
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
  __clearSessionEnvironmentsForTests();
  for (const stop of stops.splice(0).reverse()) await stop();
  await mock.stop();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/** The `<factory-*>` blocks in what the model was asked, in order, with ids and times made stable. */
function contextBlocks(request: unknown): string[] {
  const text = JSON.stringify(request);
  const found = [...text.matchAll(/<(factory-[a-z-]+)\b[^>]*>(?:(?!<\/\1>).)*<\/\1>/g)].map(match => match[0]);
  return found.map(block =>
    block
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
      .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, '<time>'),
  );
}

const tagOf = (block: string) => block.split(/[ >]/)[0];

describe('Factory context in a Mastra Code session', () => {
  it('tells the model its environment, phase and card once, then what changed', async () => {
    const settingsPath = path.join(directory, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        onboarding: { skippedAt: '2026-01-01T00:00:00.000Z', version: 1 },
        models: { activeModelPackId: null, modeDefaults: { build: `openai/${MODEL}`, plan: `openai/${MODEL}` } },
      }),
    );
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await storage.prepareRunStart({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: PROJECT_ID,
      workItem: {
        input: {
          externalSource: { integrationId: 'github', type: 'issue', externalId: 'github-issue:1' },
          title: 'Improve the settings UI',
          stages: ['planning'],
          sessions: {},
          metadata: {},
        },
      },
      role: 'plan',
      session: { sessionId: 's1', branch: 'factory/issue-1', threadId: 's1' },
      resourceId: 's1',
      kickoffKey: 'kickoff-1',
      kickoffMessage: null,
    });
    const boards = createTriageWorkRegistry();
    const phase = new FactoryPhaseStateProcessor({ configVersion: 'rules-v1', boards, storage });
    const workItem = new FactoryWorkItemStateProcessor({ storage, boards });
    recordSessionEnvironment('s1', {
      workingDirectory: '/sandbox',
      repositories: [
        {
          slug: 'octo/hello',
          dir: '/sandbox/hello',
          branch: 'factory/issue-1',
          defaultBranch: 'main',
          setupStatus: 'ok',
        },
      ],
    });
    const caller = () => new RequestContext([['user', { workosId: 'user-1', organizationId: 'org-1' }]]);
    const code = await createMastraCode({
      cwd: directory,
      homeDir: directory,
      configDir: '.mastracode-test',
      settingsPath,
      storage: new LibSQLStore({ id: 'context', url: `file:${path.join(directory, 'mastra.db')}` }),
      storageBackend: 'libsql',
      pubsub: new EventEmitterPubSub(),
      disableMcp: true,
      disableHooks: true,
      disableEnvFile: true,
      disablePlugins: true,
      disableGithubSignals: true,
      createInitialThread: false,
      inputProcessors: async () => [new FactoryEnvironmentStateProcessor(), phase, workItem],
    });
    stops.push(() => code.controller.shutdown?.());
    // What the model is asked, in full (aimock's journal cuts a body at 64 KB, this prompt is about that big).
    const asked: unknown[] = [];
    mock.on(
      {
        predicate: request => {
          asked.push(request);
          return true;
        },
      },
      { content: 'Noted.' },
    );
    const session = await code.controller.createSession({
      id: 's1',
      resourceId: 's1',
      threadId: 's1',
      ownerId: 'user-1',
      requestContext: caller(),
    });
    await session.state.set({ factoryProjectId: PROJECT_ID, factoryOrgId: 'org-1' } as never);

    // The agent's own requests, not the side calls Mastra Code makes (a thread title, say).
    const agentRequests = () => asked.filter(request => JSON.stringify(request).includes('You are Mastra Code'));
    let ends = 0;
    session.subscribe(event => {
      if (event.type === 'agent_end') ends += 1;
    });
    const turn = async (content: string) => {
      const before = agentRequests().length;
      const endsBefore = ends;
      void session.sendMessage({ content, requestContext: caller() }).catch(() => {});
      await vi.waitFor(() => expect(ends).toBeGreaterThan(endsBefore), { timeout: 30_000 });
      await new Promise(r => setTimeout(r, 500));
      return contextBlocks(agentRequests().at(-1));
    };

    const first = await turn('Plan it.');
    await storage.update({
      orgId: 'org-1',
      id: prepared.item.id,
      userId: 'user-1',
      patch: { metadata: { note: 'x' } },
    });
    const second = await turn('Go on.');
    const third = await turn('And?');

    if (process.env.CONTEXT_GOLDEN) {
      writeFileSync(process.env.CONTEXT_GOLDEN, JSON.stringify({ first, second, third }, null, 2));
    }
    expect(first.map(tagOf)).toEqual(['<factory-environment', '<factory-phase', '<factory-work-item']);
    expect(first.join('\n')).toContain('Factory work phase: Planning (planning)');
    expect(first.join('\n')).toContain('/sandbox/hello');
    // The changed card adds an update after what the thread already carries; the environment, unchanged, adds none.
    expect(second.map(tagOf)).toEqual([...first.map(tagOf), '<factory-phase', '<factory-work-item']);
    expect(second.slice(first.length)[0]).toContain('Factory phase update:');
    expect(second.slice(first.length).join('\n')).toContain('Revision: 2');
    // An unchanged turn adds nothing.
    expect(third).toEqual(second);
  });
});
