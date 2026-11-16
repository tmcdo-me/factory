import type { AuthStorage } from '@mastra/code-sdk/auth/storage';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────
// Mock the SDK flow primitives at the module boundary; the routes' session
// bookkeeping, tenancy scoping, and rate limiting are what's under test.

const { startCodexDeviceLogin, pollCodexDeviceLogin, startGitHubCopilotDeviceLogin, pollGitHubCopilotDeviceLogin } =
  vi.hoisted(() => ({
    startCodexDeviceLogin: vi.fn(),
    pollCodexDeviceLogin: vi.fn(),
    startGitHubCopilotDeviceLogin: vi.fn(),
    pollGitHubCopilotDeviceLogin: vi.fn(),
  }));
vi.mock('@mastra/code-sdk/auth/providers/openai-codex', async importOriginal => ({
  ...(await importOriginal<object>()),
  startCodexDeviceLogin: (...args: unknown[]) => startCodexDeviceLogin(...args),
  pollCodexDeviceLogin: (...args: unknown[]) => pollCodexDeviceLogin(...args),
}));
vi.mock('@mastra/code-sdk/auth/providers/github-copilot', async importOriginal => ({
  ...(await importOriginal<object>()),
  startGitHubCopilotDeviceLogin: (...args: unknown[]) => startGitHubCopilotDeviceLogin(...args),
  pollGitHubCopilotDeviceLogin: (...args: unknown[]) => pollGitHubCopilotDeviceLogin(...args),
}));

import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { FactoryStorageTestSeed } from '../storage/test-utils.js';
import { OAuthRoutes } from './oauth.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

// ── Test harness ─────────────────────────────────────────────────────────

function makeAuthStorage() {
  return {
    addAccount: vi.fn(async () => undefined),
    logout: vi.fn(),
  } as unknown as AuthStorage & {
    addAccount: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };
}

let authStorage: ReturnType<typeof makeAuthStorage>;
let seed: FactoryStorageTestSeed;

function buildApp(
  user: { workosId: string; organizationId?: string } | null,
  opts?: {
    noCredentials?: boolean;
    enabled?: boolean;
    isOrganizationAdmin?: (organizationId: string, userId: string) => Promise<boolean>;
  },
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    app as any,
    new OAuthRoutes({
      auth: fakeRouteAuth({ enabled: opts?.enabled, isOrganizationAdmin: opts?.isOrganizationAdmin }),
      authStorage,
      modelCredentials: opts?.noCredentials ? undefined : seed.credentials,
    }).routes(),
  );
  return app;
}

const userA = { workosId: 'user-a', organizationId: 'org1' };
const userB = { workosId: 'user-b', organizationId: 'org1' };
const TENANT_A = { orgId: 'org1', userId: 'user-a' };

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const ANTHROPIC_CREDS = { refresh: 'r-1', access: 'a-1', expires: Date.now() + 3_600_000 };
const CODEX_CREDS = { refresh: 'r-2', access: 'a-2', expires: Date.now() + 3_600_000 };

beforeEach(async () => {
  seed = await createFactoryStorageForTests();
  authStorage = makeAuthStorage();
  startCodexDeviceLogin.mockResolvedValue({
    deviceAuthId: 'da-1',
    userCode: 'ABCD-1234',
    url: 'https://auth.openai.com/codex/device',
    instructions: 'Enter code: ABCD-1234',
    intervalMs: 5000,
    deadlineAt: Date.now() + 900_000,
  });
  pollCodexDeviceLogin.mockResolvedValue({ status: 'pending', nextPollMs: 5000 });
  startGitHubCopilotDeviceLogin.mockResolvedValue({
    domain: 'github.com',
    deviceCode: 'dc-1',
    userCode: 'WXYZ-5678',
    url: 'https://github.com/login/device',
    instructions: 'Enter code: WXYZ-5678',
    intervalMs: 5000,
    intervalMultiplier: 1,
    deadlineAt: Date.now() + 900_000,
  });
  pollGitHubCopilotDeviceLogin.mockResolvedValue({ status: 'pending', nextPollMs: 5000 });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Force a device session to be immediately pollable. */
async function makePollable(sessionId: string) {
  await seed.credentials.touchLoginSession(sessionId, { nextPollAt: new Date(Date.now() - 1) });
}

// ── No Claude subscription sign-in (Anthropic) ───────────────────────────
// fork(claude-agent): Factory must not sign anyone in with their Claude subscription and store
// it for Mastra Code (spec §2.6); only Claude Code, run as Claude Agent, may use a subscription.

describe('Claude subscription sign-in is gone (anthropic)', () => {
  it('refuses to start an Anthropic sign-in and records no login session', async () => {
    const app = buildApp(userA);
    const res = await post(app, '/web/config/providers/anthropic/oauth/start');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'oauth_not_supported' });

    // Nothing to poll or complete: the paste-code exchange route no longer exists.
    const complete = await post(app, '/web/config/providers/anthropic/oauth/complete', {
      sessionId: 'any',
      code: 'code#state',
    });
    expect(complete.status).toBe(404);
    const poll = await post(app, '/web/config/providers/anthropic/oauth/poll', { sessionId: 'any' });
    expect(poll.status).toBe(404);
    expect(await seed.credentials.listCredentials('org1', 'user-a')).toEqual([]);
  });

  it('refuses an org-wide Anthropic sign-in the same way', async () => {
    const res = await post(buildApp(userA), '/web/config/providers/anthropic/oauth/start', { scope: 'org' });
    expect(res.status).toBe(404);
  });

  it('refuses it in local mode, writing nothing to auth.json', async () => {
    const res = await post(buildApp(null, { enabled: false }), '/web/config/providers/anthropic/oauth/start');
    expect(res.status).toBe(404);
    expect(authStorage.addAccount).not.toHaveBeenCalled();
  });

  it('still signs out a stored Anthropic sign-in so the person can remove it', async () => {
    await seed.credentials.setCredential(TENANT_A, 'anthropic', { type: 'oauth', ...ANTHROPIC_CREDS });
    const res = await buildApp(userA).request('/web/config/providers/anthropic/oauth', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await seed.credentials.getCredential(TENANT_A, 'anthropic')).toBeUndefined();
  });
});

// ── Device-code flow (OpenAI Codex) ──────────────────────────────────────

describe('device-code flow (openai)', () => {
  it('start returns the user code and initial poll delay', async () => {
    const res = await post(buildApp(userA), '/web/config/providers/openai/oauth/start');
    const json = await res.json();
    expect(json).toMatchObject({ kind: 'device-code', userCode: 'ABCD-1234', nextPollMs: 5000 });
    expect(json.url).toContain('device');
  });

  it('rate-limits polls server-side without hitting the provider', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();

    const res = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    const json = await res.json();
    expect(json.status).toBe('pending');
    expect(json.nextPollMs).toBeGreaterThan(0);
    expect(pollCodexDeviceLogin).not.toHaveBeenCalled();
  });

  it('performs one upstream poll when due and reschedules', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);

    const res = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(await res.json()).toMatchObject({ status: 'pending', nextPollMs: 5000 });
    expect(pollCodexDeviceLogin).toHaveBeenCalledTimes(1);

    // Immediately polling again is rate-limited — still one upstream call.
    await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(pollCodexDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it('tells a poll that arrives while another poll holds the session to retry shortly', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);

    let releaseUpstream!: () => void;
    pollCodexDeviceLogin.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseUpstream = () => resolve({ status: 'pending', nextPollMs: 5000 });
        }),
    );

    // Poll A claims the session and waits on the provider.
    const first = post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    await vi.waitFor(() => expect(pollCodexDeviceLogin).toHaveBeenCalledTimes(1));

    // Poll B arrives while A still holds the claim.
    const second = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(await second.json()).toEqual({ status: 'pending', nextPollMs: 250 });
    expect(pollCodexDeviceLogin).toHaveBeenCalledTimes(1);

    releaseUpstream();
    expect(await (await first).json()).toMatchObject({ status: 'pending', nextPollMs: 5000 });
  });

  it('stores the credential under the openai-codex auth id on completion', async () => {
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);

    const res = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(await res.json()).toMatchObject({ status: 'complete' });
    expect(await seed.credentials.getCredential(TENANT_A, 'openai-codex')).toMatchObject({
      type: 'oauth',
      access: 'a-2',
    });
    // Session is gone.
    expect((await post(app, '/web/config/providers/openai/oauth/poll', { sessionId })).status).toBe(404);
  });

  it('deletes the session and reports failure when the flow fails', async () => {
    pollCodexDeviceLogin.mockResolvedValue({ status: 'failed', error: 'Device flow timed out' });
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);

    const res = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'Device flow timed out' });
    expect((await post(app, '/web/config/providers/openai/oauth/poll', { sessionId })).status).toBe(404);
  });

  it("keeps user A's credential invisible to user B", async () => {
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);
    await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });

    expect(await seed.credentials.listCredentials('org1', 'user-b')).toEqual([]);
    expect(await seed.credentials.resolveCredential('org1', 'user-b', 'openai-codex', 'user')).toBeUndefined();
  });

  it("404s when another user polls someone else's session", async () => {
    const { sessionId } = await (await post(buildApp(userA), '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);

    const res = await post(buildApp(userB), '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(res.status).toBe(404);
    expect(pollCodexDeviceLogin).not.toHaveBeenCalled();
  });
});

// ── Device-code flow (GitHub Copilot) ────────────────────────────────────

describe('device-code flow (github-copilot)', () => {
  it('polls github.com sessions normally', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/github-copilot/oauth/start')).json();
    await makePollable(sessionId);

    const res = await post(app, '/web/config/providers/github-copilot/oauth/poll', { sessionId });
    expect(await res.json()).toMatchObject({ status: 'pending' });
    expect(pollGitHubCopilotDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it('refuses to poll a session whose stored state points at a non-github.com host', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/github-copilot/oauth/start')).json();
    const session = await seed.credentials.getLoginSession(sessionId);
    await seed.credentials.touchLoginSession(sessionId, {
      pending: { ...session!.pending, domain: 'evil.example.com' },
      nextPollAt: new Date(Date.now() - 1),
    });

    const res = await post(app, '/web/config/providers/github-copilot/oauth/poll', { sessionId });
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'Unsupported GitHub host' });
    expect(pollGitHubCopilotDeviceLogin).not.toHaveBeenCalled();
  });

  it('refuses to poll a session whose stored state carries an enterprise domain', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/github-copilot/oauth/start')).json();
    const session = await seed.credentials.getLoginSession(sessionId);
    await seed.credentials.touchLoginSession(sessionId, {
      pending: { ...session!.pending, enterpriseDomain: 'company.ghe.com' },
      nextPollAt: new Date(Date.now() - 1),
    });

    const res = await post(app, '/web/config/providers/github-copilot/oauth/poll', { sessionId });
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'Unsupported GitHub host' });
    expect(pollGitHubCopilotDeviceLogin).not.toHaveBeenCalled();
  });
});

// ── Session cancel + sign-out ────────────────────────────────────────────

describe('session cancel and sign-out', () => {
  it('cancels a pending session', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();

    const res = await app.request(`/web/config/providers/openai/oauth/session/${sessionId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await post(app, '/web/config/providers/openai/oauth/poll', { sessionId })).status).toBe(404);
  });

  it("sign-out removes only the caller's user-scoped credential", async () => {
    await seed.credentials.setCredential(TENANT_A, 'anthropic', { type: 'oauth', ...ANTHROPIC_CREDS });
    await seed.credentials.setCredential({ orgId: 'org1', userId: 'user-b' }, 'anthropic', {
      type: 'oauth',
      ...ANTHROPIC_CREDS,
    });
    await seed.credentials.setCredential({ orgId: 'org1' }, 'anthropic', { type: 'api_key', key: 'org-key' });

    const res = await buildApp(userA).request('/web/config/providers/anthropic/oauth', { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(await seed.credentials.getCredential(TENANT_A, 'anthropic')).toBeUndefined();
    expect(await seed.credentials.getCredential({ orgId: 'org1', userId: 'user-b' }, 'anthropic')).toBeDefined();
    expect(await seed.credentials.getCredential({ orgId: 'org1' }, 'anthropic')).toBeDefined();
    expect(authStorage.logout).not.toHaveBeenCalled();
  });
});

// ── Org-scoped sign-in ───────────────────────────────────────────────────

describe('provider login preserves OM selection intent', () => {
  it('leaves automatic roles unset after device-code completion', async () => {
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);
    await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });

    expect(await seed.memorySettings.get(TENANT_A)).toBeNull();
    expect(await seed.memorySettings.get({ orgId: 'org1', userId: 'user-b' })).toBeNull();
  });

  it('keeps an explicit role pinned without materializing the automatic sibling', async () => {
    await seed.memorySettings.patch({ ...TENANT_A, patch: { observerModelId: 'openai/gpt-5.4-mini' } });
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    await makePollable(sessionId);
    await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });

    expect(await seed.memorySettings.get(TENANT_A)).toMatchObject({
      observerModelId: 'openai/gpt-5.4-mini',
      reflectorModelId: null,
    });
  });
});

describe('org-scoped sign-in', () => {
  it('device-code poll stores an org-scoped credential when started with scope org', async () => {
    const app = buildApp(userA);
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start', { scope: 'org' })).json();
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    await makePollable(sessionId);

    const res = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'complete' });

    expect(await seed.credentials.getCredential(TENANT_A, 'openai-codex')).toBeUndefined();
    expect(await seed.credentials.getCredential({ orgId: 'org1' }, 'openai-codex')).toMatchObject({ type: 'oauth' });
    // Visible to other org members through factory-scoped resolution.
    expect(await seed.credentials.resolveCredential('org1', 'user-b', 'openai-codex', 'org')).toBeDefined();
  });

  it('403s device-code poll when admin access was revoked after the org-scoped flow started', async () => {
    const { sessionId } = await (
      await post(buildApp(userA), '/web/config/providers/openai/oauth/start', { scope: 'org' })
    ).json();
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    await makePollable(sessionId);

    const revoked = buildApp(userA, { isOrganizationAdmin: async () => false });
    const res = await post(revoked, '/web/config/providers/openai/oauth/poll', { sessionId });
    expect(res.status).toBe(403);
    expect(await seed.credentials.getCredential({ orgId: 'org1' }, 'openai-codex')).toBeUndefined();
  });

  it('403s a non-admin starting an org-scoped flow', async () => {
    const app = buildApp(userA, { isOrganizationAdmin: async () => false });
    const res = await post(app, '/web/config/providers/openai/oauth/start', { scope: 'org' });
    expect(res.status).toBe(403);
  });

  it('sign-out with scope=org removes the shared org credential (admin only)', async () => {
    await seed.credentials.setCredential({ orgId: 'org1' }, 'anthropic', { type: 'oauth', ...ANTHROPIC_CREDS });
    await seed.credentials.setCredential(TENANT_A, 'anthropic', { type: 'oauth', ...ANTHROPIC_CREDS });

    const forbidden = await buildApp(userA, { isOrganizationAdmin: async () => false }).request(
      '/web/config/providers/anthropic/oauth?scope=org',
      { method: 'DELETE' },
    );
    expect(forbidden.status).toBe(403);

    const res = await buildApp(userA).request('/web/config/providers/anthropic/oauth?scope=org', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await seed.credentials.getCredential({ orgId: 'org1' }, 'anthropic')).toBeUndefined();
    // Personal credential untouched.
    expect(await seed.credentials.getCredential(TENANT_A, 'anthropic')).toBeDefined();
  });
});

// ── Gating ───────────────────────────────────────────────────────────────

describe('gating', () => {
  it('404s for a provider without a web OAuth flow', async () => {
    const res = await post(buildApp(userA), '/web/config/providers/google/oauth/start');
    expect(res.status).toBe(404);
  });

  it('401s unauthenticated requests when an auth provider is active', async () => {
    const res = await post(buildApp(null), '/web/config/providers/openai/oauth/start');
    expect(res.status).toBe(401);
  });

  it('503s tenant writes when the credentials domain is unavailable', async () => {
    // Auth active + user present, but no credentials domain handle at all.
    const res = await post(buildApp(userA, { noCredentials: true }), '/web/config/providers/openai/oauth/start');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('credentials_unavailable');
  });
});

// ── Local mode (no auth adapter, no tenant) ──────────────────────────────

describe('local mode', () => {
  // No auth enabled and no tenant user: requests fall back to AuthStorage.
  it('completes a device-code flow into the file-backed AuthStorage', async () => {
    pollCodexDeviceLogin.mockResolvedValue({ status: 'complete', credentials: CODEX_CREDS });
    const app = buildApp(null, { enabled: false });
    const { sessionId } = await (await post(app, '/web/config/providers/openai/oauth/start')).json();
    // Local sessions live in a process-local store the test can't reach, so wait out the first interval.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6000);
    try {
      const res = await post(app, '/web/config/providers/openai/oauth/poll', { sessionId });
      expect(await res.json()).toMatchObject({ status: 'complete' });
    } finally {
      vi.useRealTimers();
    }
    expect(authStorage.addAccount).toHaveBeenCalledWith('openai-codex', CODEX_CREDS);
  });

  it('signs out via AuthStorage using the auth provider id', async () => {
    const res = await buildApp(null, { enabled: false }).request('/web/config/providers/openai/oauth', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(authStorage.logout).toHaveBeenCalledWith('openai-codex');
  });
});
