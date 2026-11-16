// fork(claude-agent): uses OpenAI (key + device-code sign-in); Anthropic takes an API key only now.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { OAuthStartResponse, ProviderInfo } from '../../../../../api/types';
import { chooseProvider, chooseSubscription, renderModelSection } from './fixtures/modelSection';

const base = `${TEST_BASE_URL}/web/config/providers`;
beforeEach(() => {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    // A connected personal lane starts on the caller's saved default model, when there is one.
    http.get(`${TEST_BASE_URL}/web/config/default-model`, () =>
      HttpResponse.json({ modelId: null, thinkingLevel: null }),
    ),
  );
});

function registerProvider(provider: () => ProviderInfo) {
  server.use(
    http.get(base, () => HttpResponse.json({ providers: [provider()], orgKeyAdmin: true })),
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({
        models: [{ id: 'openai/gpt-5.6-sol', provider: 'openai', modelName: 'gpt-5.6-sol', hasApiKey: true }],
      }),
    ),
  );
}

const openai: ProviderInfo = {
  provider: 'openai',
  source: 'none',
  envVar: 'OPENAI_API_KEY',
  oauth: { supported: true, modes: ['device-code'] },
};

const deviceCodeSession = (nextPollMs: number): OAuthStartResponse => ({
  sessionId: 'sign-in-1',
  kind: 'device-code',
  url: 'https://example.com/device',
  userCode: 'ABCD-1234',
  instructions: 'Enter this code.',
  expiresAt: Date.now() + 600_000,
  nextPollMs,
});

describe('provider method and scope are independent choices', () => {
  it('offers an organization API key even when the provider supports sign-in', async () => {
    let saved = false;
    registerProvider(() => ({
      ...openai,
      source: saved ? 'stored-org' : 'none',
      ...(saved ? { orgCredential: 'api_key' } : {}),
    }));
    const writes: unknown[] = [];
    server.use(
      http.put(`${base}/openai/key`, async ({ request }) => {
        writes.push(await request.json());
        saved = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderModelSection({ draft: { modelScope: 'factory' } });
    await chooseProvider(user, 'OpenAI');
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Everyone in your organization can use this key\./)).toBeInTheDocument();
    await user.type(dialog.getByLabelText('API key for OpenAI'), 'test-key');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('combobox')).toHaveValue('GPT-5.6 Sol');
    expect(writes).toEqual([{ key: 'test-key', envVar: 'OPENAI_API_KEY', scope: 'org' }]);
  });

  it('uses a local sign-in from the API key list instead of asking for a key it would never use', async () => {
    server.use(http.get(`${TEST_BASE_URL}/auth/me`, () => new HttpResponse(null, { status: 404 })));
    registerProvider(() => ({ ...openai, source: 'oauth' }));
    const user = userEvent.setup();
    renderModelSection({ draft: { modelScope: 'factory' } });
    await chooseProvider(user, 'OpenAI');
    expect(await screen.findByRole('combobox')).toHaveValue('GPT-5.6 Sol');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts organization sign-in instead of treating an existing API key as a sign-in connection', async () => {
    registerProvider(() => ({ ...openai, source: 'stored-org', orgCredential: 'api_key' }));
    const starts: unknown[] = [];
    server.use(
      http.post(`${base}/openai/oauth/start`, async ({ request }) => {
        starts.push(await request.json());
        // Never reaches the first poll: this test is about how the sign-in starts.
        return HttpResponse.json(deviceCodeSession(600_000));
      }),
    );
    const user = userEvent.setup();
    renderModelSection({ draft: { modelScope: 'factory' } });
    await chooseSubscription(user, 'Continue with OpenAI');
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/Everyone in your organization.*replaces the existing connection/)).toBeInTheDocument();
    expect(starts).toEqual([{ mode: 'device-code', scope: 'org' }]);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('connects personal sign-in without reusing or replacing the organization connection', async () => {
    let saved = false;
    registerProvider(() => ({
      ...openai,
      source: 'oauth-org',
      orgCredential: 'oauth',
      ...(saved ? { userCredential: 'oauth' } : {}),
    }));
    const starts: unknown[] = [];
    // The provider authorizes the device only once the test has read the sign-in dialog.
    let authorize = () => {};
    const authorized = new Promise<void>(resolve => {
      authorize = resolve;
    });
    server.use(
      http.post(`${base}/openai/oauth/start`, async ({ request }) => {
        starts.push(await request.json());
        return HttpResponse.json(deviceCodeSession(10));
      }),
      http.post(`${base}/openai/oauth/poll`, async () => {
        await authorized;
        saved = true;
        return HttpResponse.json({ status: 'complete' });
      }),
    );
    const user = userEvent.setup();
    renderModelSection({ draft: { modelScope: 'user' } });
    await chooseSubscription(user, 'Continue with OpenAI');
    const dialog = within(await screen.findByRole('dialog'));
    expect(
      dialog.getByText('This provider connection is only for you. Shared organization access stays unchanged.'),
    ).toBeInTheDocument();
    expect(starts).toEqual([{ mode: 'device-code', scope: 'user' }]);
    expect(dialog.getByText('ABCD-1234')).toBeInTheDocument();
    authorize();
    expect(await screen.findByRole('combobox')).toHaveValue('GPT-5.6 Sol');
  });

  it('warns that a personal API key replaces personal sign-in and saves only at user scope', async () => {
    let saved = false;
    registerProvider(() => ({
      ...openai,
      source: saved ? 'stored-user' : 'oauth-user',
      orgCredential: 'api_key',
      userCredential: saved ? 'api_key' : 'oauth',
    }));
    const writes: unknown[] = [];
    server.use(
      http.put(`${base}/openai/key`, async ({ request }) => {
        writes.push(await request.json());
        saved = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderModelSection({ draft: { modelScope: 'user' } });
    await chooseProvider(user, 'OpenAI');
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Only you can use this key.*replaces the provider sign-in/)).toBeInTheDocument();
    await user.type(dialog.getByLabelText('API key for OpenAI'), 'test-key');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([{ key: 'test-key', envVar: 'OPENAI_API_KEY', scope: 'user' }]);
    expect(await screen.findByRole('combobox')).toHaveValue('GPT-5.6 Sol');
  });
});
