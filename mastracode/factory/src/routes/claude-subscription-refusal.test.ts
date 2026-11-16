/**
 * fork(claude-agent): Mastra Code never calls Anthropic with a Claude subscription (spec §2, slice 12).
 *
 * A person who signed in with Claude Pro/Max before Factory removed that sign-in still has the
 * credential stored, in the tenant `model-credentials` table or in local `auth.json`. Factory keeps
 * the row but must not use it: an Anthropic model fails with a clear "use an API key or Claude Agent"
 * error, nothing is sent to Anthropic (no model call, no token refresh), and an Anthropic API key keeps
 * working.
 *
 * Runs the real `resolveModel` (code-sdk) against real credential storage, with a local HTTP server
 * standing in for the Anthropic API (`ANTHROPIC_BASE_URL`), and records every other outbound request.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { resolveAuthenticatedCredentialTenant } from '@mastra/code-sdk/agents/credential-resolver';
import { resolveModel } from '@mastra/code-sdk/agents/model';
import {
  CLAUDE_SUBSCRIPTION_REFUSED_ERROR,
  isClaudeSubscriptionRefused,
  refuseClaudeSubscriptionCredentials,
} from '@mastra/code-sdk/auth/claude-subscription-policy';
import { AuthStorage } from '@mastra/code-sdk/auth/storage';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MastraFactory } from '../factory.js';
import { describeRunError } from '../run-error.js';
import { createFactorySecretEncryption } from '../secret-encryption.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { FactoryStorageTestSeed } from '../storage/test-utils.js';
import {
  invalidateTenantCredentialSnapshots,
  registerTenantCredentialResolver,
  resetTenantCredentialResolverForTests,
} from './tenant-credentials.js';

const MODEL = 'anthropic/claude-opus-4-6';
const SUBSCRIPTION_SIGN_IN = {
  type: 'oauth' as const,
  access: 'sk-ant-oat01-access',
  refresh: 'sk-ant-ort01-refresh',
  // Expired, so a refresh against Anthropic's token endpoint would be the next step if it were used.
  expires: Date.now() - 60_000,
};
const API_KEY = 'sk-ant-api03-test-key';

const SSE = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

/** Requests that reached the stand-in Anthropic API. */
let anthropicRequests: IncomingHttpHeaders[] = [];
/** Requests to any other host (the real Anthropic API, its OAuth token endpoint, …). */
let otherRequests: string[] = [];
let server: Server;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const appDataDir = join(process.env.TMPDIR ?? '/Volumes/Dev/tmp', `factory-claude-refusal-${process.pid}`);

beforeAll(async () => {
  server = createServer((req, res) => {
    anthropicRequests.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
      otherRequests.push(url);
      throw new Error(`unexpected outbound request: ${url}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  process.env = savedEnv;
  rmSync(appDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  anthropicRequests = [];
  otherRequests = [];
  rmSync(appDataDir, { recursive: true, force: true });
  mkdirSync(appDataDir, { recursive: true });
  process.env.MASTRA_APP_DATA_DIR = appDataDir;
  delete process.env.ANTHROPIC_API_KEY;
  refuseClaudeSubscriptionCredentials();
});

afterEach(() => {
  resetTenantCredentialResolverForTests();
  refuseClaudeSubscriptionCredentials(false);
});

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

/** One model call, read to the end; resolves to the error it failed with, if any. */
async function callModel(requestContext?: RequestContext): Promise<Error | undefined> {
  try {
    const model = resolveModel(MODEL, { requestContext }) as unknown as {
      doStream(options: unknown): Promise<{ stream: ReadableStream<{ type: string; error?: unknown }> }>;
    };
    const { stream } = await model.doStream({ prompt });
    for await (const part of stream as unknown as AsyncIterable<{ type: string; error?: unknown }>) {
      if (part.type === 'error') return part.error as Error;
    }
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

function expectRefused(error: Error | undefined) {
  expect(error?.name).toBe(CLAUDE_SUBSCRIPTION_REFUSED_ERROR);
  expect(error?.message).toMatch(/Claude API key/);
  expect(error?.message).toMatch(/Claude Agent/);
  expect(describeRunError(error!)).toMatchObject({
    title: 'Anthropic API key required',
    recoveries: ['credentials', 'model'],
  });
  // Nothing went to Anthropic: no model call, no OAuth token refresh.
  expect(anthropicRequests).toEqual([]);
  expect(otherRequests).toEqual([]);
}

function expectServedWithApiKey(error: Error | undefined) {
  expect(error).toBeUndefined();
  expect(anthropicRequests).toHaveLength(1);
  expect(anthropicRequests[0]?.['x-api-key']).toBe(API_KEY);
  expect(anthropicRequests[0]?.authorization).toBeUndefined();
  expect(otherRequests).toEqual([]);
}

describe('Factory turns the refusal on', () => {
  it('refuses Claude subscription credentials once a Factory is constructed', () => {
    refuseClaudeSubscriptionCredentials(false);
    new MastraFactory({
      secretEncryption: createFactorySecretEncryption({ primary: { id: 'test', key: Buffer.alloc(32, 7) } }),
      storage: new LibSQLFactoryStorage({ url: ':memory:', id: 'claude-refusal-test' }),
    });
    expect(isClaudeSubscriptionRefused()).toBe(true);
  });
});

describe('deployed Factory (tenant credentials)', () => {
  let seed: FactoryStorageTestSeed;
  const tenant = { orgId: 'org1', userId: 'user-a' };

  beforeEach(async () => {
    seed = await createFactoryStorageForTests();
    registerTenantCredentialResolver(seed.credentials, new Set(), resolveAuthenticatedCredentialTenant);
  });

  const requestContext = () => {
    const context = new RequestContext();
    context.set('user', { workosId: 'user-a', organizationId: 'org1' });
    return context;
  };

  it('refuses a stored Claude Pro/Max sign-in for an Anthropic model, and keeps the row', async () => {
    await seed.credentials.setCredential(tenant, 'anthropic', SUBSCRIPTION_SIGN_IN);

    expectRefused(await callModel(requestContext()));
    expect(await seed.credentials.getCredential(tenant, 'anthropic')).toMatchObject({ type: 'oauth' });
  });

  it('refuses a Claude subscription token stored as an Anthropic key', async () => {
    await seed.credentials.setCredential(tenant, 'anthropic', { type: 'api_key', key: 'sk-ant-oat01-setup-token' });

    expectRefused(await callModel(requestContext()));
  });

  it('calls Anthropic with an Anthropic API key', async () => {
    await seed.credentials.setCredential(tenant, 'anthropic', SUBSCRIPTION_SIGN_IN);
    expectRefused(await callModel(requestContext()));

    // The person replaces the sign-in with an API key in Settings.
    await seed.credentials.setCredential(tenant, 'anthropic', { type: 'api_key', key: API_KEY });
    invalidateTenantCredentialSnapshots(tenant);

    expectServedWithApiKey(await callModel(requestContext()));
  });
});

describe('local Factory (auth.json and environment)', () => {
  it('refuses a Claude Pro/Max sign-in in auth.json', async () => {
    new AuthStorage().set('anthropic', SUBSCRIPTION_SIGN_IN);

    expectRefused(await callModel());
  });

  it('never reads or refreshes the auth.json sign-in, even for an account rotation', async () => {
    const storage = new AuthStorage();
    storage.set('anthropic', SUBSCRIPTION_SIGN_IN);

    await expect(storage.getApiKey('anthropic')).resolves.toBeUndefined();
    await expect(storage.forceRefreshActiveAccount('anthropic')).resolves.toBeUndefined();
    expect(otherRequests).toEqual([]);
    expect(new AuthStorage().get('anthropic')).toMatchObject({ refresh: SUBSCRIPTION_SIGN_IN.refresh });
  });

  it('refuses a Claude subscription token in ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat01-setup-token';

    expectRefused(await callModel());
  });

  it('uses an Anthropic API key saved next to a refused sign-in', async () => {
    const storage = new AuthStorage();
    storage.set('anthropic', SUBSCRIPTION_SIGN_IN);
    storage.setStoredApiKey('anthropic', API_KEY);

    expectServedWithApiKey(await callModel());
  });

  it('uses an Anthropic API key from ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = API_KEY;

    expectServedWithApiKey(await callModel());
  });
});
