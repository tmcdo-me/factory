// fork(claude-agent): sign-in tests use device-code providers (the Anthropic paste-code sign-in is gone) and cover a refused Claude subscription.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../../../e2e/ui/render';
import type { ProviderInfo } from '../../../../../../../api/types';
import { useAvailableModelsQuery } from '../../../../../../../hooks/useAvailableModels';
import type { AvailableModelOption } from '../../../../../../../hooks/useAvailableModels';
import { ProviderList } from '../ProviderList';
import {
  PROVIDERS_URL,
  deviceCodeSession,
  keyUrl,
  oauthUrl,
  openAddProvider,
  pickRowAction,
  rowFor,
  saveKey,
  stubProviders,
} from './provider-list-test-utils';

describe('ProviderList', () => {
  it('shows a skeleton while loading, then only the connected providers', async () => {
    server.use(
      http.get(PROVIDERS_URL, async () => {
        await delay(100);
        return HttpResponse.json({
          providers: [
            { provider: 'openai', source: 'stored' },
            { provider: 'anthropic', source: 'none' },
          ],
        });
      }),
    );

    renderWithProviders(<ProviderList credentialScope="user" />);

    expect(await screen.findByRole('status', { name: 'Loading providers' })).toBeInTheDocument();
    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(within(rowFor('openai')).getByText('Key saved')).toBeInTheDocument();
    expect(screen.queryByText('Anthropic')).not.toBeInTheDocument();
  });

  it('connects the Mastra Gateway in one click and offers to add credits when the organization has none', async () => {
    let connected = false;
    server.use(
      http.get(PROVIDERS_URL, () =>
        HttpResponse.json({
          providers: [
            connected
              ? { provider: 'mastra', source: 'stored-user', userCredential: 'api_key', connectWithMastraAccount: true }
              : { provider: 'mastra', source: 'none', connectWithMastraAccount: true },
            { provider: 'anthropic', source: 'none' },
          ],
        }),
      ),
      http.post(`${PROVIDERS_URL}/mastra/connect`, () => {
        connected = true;
        return HttpResponse.json({ ok: true });
      }),
      http.get(`${PROVIDERS_URL}/mastra/credits`, () =>
        HttpResponse.json({
          remaining: 0,
          unlimited: false,
          canAddCredits: true,
          addCreditsUrl: 'https://projects.mastra.ai/add-credits/org-1',
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    const drawer = await openAddProvider(user);
    expect(await within(drawer).findByText('Pay with your organization’s Mastra credits ($0.00 left)')).toBeVisible();
    await user.click(within(drawer).getByRole('button', { name: 'Connect Mastra Gateway' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add provider' })).not.toBeInTheDocument());
    expect(await screen.findByText('No gateway credits left')).toBeInTheDocument();
    expect(within(rowFor('mastra')).getByText('Key saved')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add credits' })).toHaveAttribute(
      'href',
      'https://projects.mastra.ai/add-credits/org-1',
    );
  });

  it('lets the user remove the Mastra Gateway key Factory created, but not replace it', async () => {
    stubProviders([
      { provider: 'mastra', source: 'stored-user', userCredential: 'api_key', connectWithMastraAccount: true },
    ]);
    server.use(
      http.get(`${PROVIDERS_URL}/mastra/credits`, () =>
        HttpResponse.json({
          remaining: 5,
          unlimited: false,
          canAddCredits: true,
          addCreditsUrl: 'https://projects.mastra.ai/add-credits/org-1',
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    await user.click(await screen.findByRole('button', { name: 'Mastra Gateway actions' }));

    expect(await screen.findByRole('menuitem', { name: 'Remove key' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Update key' })).not.toBeInTheDocument();
  });

  it('surfaces a provider list error', async () => {
    server.use(http.get(PROVIDERS_URL, () => HttpResponse.json({ error: 'nope' }, { status: 500 })));

    renderWithProviders(<ProviderList credentialScope="user" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });

  it('offers sign-in providers first and finds API-key providers by search', async () => {
    stubProviders([
      { provider: 'openai', source: 'none' },
      { provider: 'xai', source: 'none', oauth: { supported: true, modes: ['device-code'] } },
      { provider: 'google', source: 'none' },
    ]);
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    const dialog = await openAddProvider(user);
    expect(within(dialog).getByText('xAI')).toBeInTheDocument();
    expect(within(dialog).queryByText('OpenAI')).not.toBeInTheDocument();
    expect(within(dialog).getByText('2 more take an API key. Type to find one.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Search providers'), 'open');
    expect(within(dialog).getByText('OpenAI')).toBeInTheDocument();
    expect(within(dialog).queryByText('xAI')).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Search providers'), 'zzz');
    expect(within(dialog).getByText('No providers match “openzzz”.')).toBeInTheDocument();
  });

  it('saves an API key found in the add dialog and refetches the model catalog', async () => {
    const providers: ProviderInfo[] = [{ provider: 'openai', source: 'none', envVar: 'OPENAI_API_KEY' }];
    const models: AvailableModelOption[] = [];
    let putBody: unknown;
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ providers })),
      http.get(`${TEST_BASE_URL}/web/config/models`, () => HttpResponse.json({ models })),
      http.put(keyUrl('openai'), async ({ request }) => {
        putBody = await request.json();
        providers[0] = { provider: 'openai', source: 'stored', envVar: 'OPENAI_API_KEY' };
        models.push({ id: 'openai/gpt-4o', provider: 'openai', modelName: 'gpt-4o', hasApiKey: true });
        return HttpResponse.json({ ok: true });
      }),
    );

    function ModelCatalogProbe() {
      const query = useAvailableModelsQuery();
      return <output aria-label="Model catalog">{(query.data ?? []).map(model => model.id).join(',')}</output>;
    }

    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ProviderList credentialScope="user" />
        <ModelCatalogProbe />
      </>,
    );

    const dialog = await openAddProvider(user);
    await user.type(within(dialog).getByLabelText('Search providers'), 'openai');
    await user.click(within(dialog).getByRole('button', { name: 'Add API key for OpenAI' }));
    await saveKey(user, 'sk-test');

    await waitFor(() => expect(putBody).toEqual({ key: 'sk-test', envVar: 'OPENAI_API_KEY' }));
    await waitFor(() => expect(within(rowFor('openai')).getByText('Key saved')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Model catalog' })).toHaveTextContent('openai/gpt-4o'),
    );
  });

  it('shows a removing key as pending with its menu locked, then drops the row', async () => {
    const providers: ProviderInfo[] = [{ provider: 'openai', source: 'stored' }];
    let releaseDelete = () => {};
    const deleteHeld = new Promise<void>(resolve => {
      releaseDelete = resolve;
    });
    let removed = false;
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ providers })),
      http.delete(keyUrl('openai'), async () => {
        removed = true;
        await deleteHeld;
        providers.length = 0;
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    await screen.findByText('OpenAI');
    await pickRowAction(user, 'openai', 'Remove key');

    await waitFor(() => expect(removed).toBe(true));
    expect(within(rowFor('openai')).getByText('Removing…')).toBeInTheDocument();
    expect(within(rowFor('openai')).getByRole('button', { name: 'OpenAI actions' })).toBeDisabled();

    releaseDelete();
    await waitFor(() => expect(screen.queryByText('OpenAI')).not.toBeInTheDocument());
  });

  it('shows a failed sign-in start in the add dialog and forgets it once the dialog closes', async () => {
    stubProviders([{ provider: 'xai', source: 'none', oauth: { supported: true, modes: ['device-code'] } }]);
    server.use(
      http.post(oauthUrl('xai', 'start'), () =>
        HttpResponse.json({ error: 'xAI sign-in is unavailable' }, { status: 503 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    const dialog = await openAddProvider(user);
    await user.click(within(dialog).getByRole('button', { name: 'Sign in to xAI' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('xAI sign-in is unavailable');
    expect(within(dialog).getByRole('button', { name: 'Sign in to xAI' })).toBeEnabled();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add provider' })).not.toBeInTheDocument());
    const reopened = await openAddProvider(user);
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('polls a device-code sign-in until it completes', async () => {
    const providers: ProviderInfo[] = [
      { provider: 'xai', source: 'none', oauth: { supported: true, modes: ['device-code'] } },
    ];
    let pollCount = 0;
    let startBody: unknown;
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ providers })),
      http.post(oauthUrl('xai', 'start'), async ({ request }) => {
        startBody = await request.json();
        return HttpResponse.json(deviceCodeSession('session-2', 'GROK-123', 100));
      }),
      http.post(oauthUrl('xai', 'poll'), () => {
        pollCount += 1;
        if (pollCount === 1) return HttpResponse.json({ status: 'pending', nextPollMs: 100 });
        providers[0] = { ...providers[0], source: 'oauth-user' };
        return HttpResponse.json({ status: 'complete', ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    const dialog = await openAddProvider(user);
    await user.click(within(dialog).getByRole('button', { name: 'Sign in to xAI' }));

    expect(await screen.findByText('GROK-123')).toBeInTheDocument();
    expect(startBody).toEqual({ mode: 'device-code' });
    await waitFor(() => expect(within(rowFor('xai')).getByText('Signed in')).toBeInTheDocument());
  });

  it('closes a device-code sign-in once persisted, without a stale second poll', async () => {
    const providers: ProviderInfo[] = [
      { provider: 'openai', source: 'none', oauth: { supported: true, modes: ['device-code'] } },
    ];
    let pollCount = 0;
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ providers })),
      http.post(oauthUrl('openai', 'start'), () =>
        HttpResponse.json(deviceCodeSession('session-race', 'OPENAI-123', 10)),
      ),
      http.post(oauthUrl('openai', 'poll'), async () => {
        pollCount += 1;
        if (pollCount > 1) {
          await delay(50);
          return HttpResponse.error();
        }
        await delay(20);
        providers[0] = { ...providers[0], source: 'oauth-user' };
        return HttpResponse.json({ status: 'complete', ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    const dialog = await openAddProvider(user);
    await user.click(within(dialog).getByRole('button', { name: 'Sign in to OpenAI' }));

    await waitFor(() => expect(within(rowFor('openai')).getByText('Signed in')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pollCount).toBe(1);
  });

  it('signs out from the row menu', async () => {
    const providers: ProviderInfo[] = [
      { provider: 'openai', source: 'oauth-user', oauth: { supported: true, modes: ['device-code'] } },
    ];
    let signedOut = false;
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ providers })),
      http.delete(`${PROVIDERS_URL}/openai/oauth`, () => {
        signedOut = true;
        providers[0] = { ...providers[0], source: 'none' };
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    await screen.findByText('OpenAI');
    await pickRowAction(user, 'openai', 'Sign out');

    await waitFor(() => expect(signedOut).toBe(true));
    await waitFor(() => expect(screen.queryByText('OpenAI')).not.toBeInTheDocument());
  });

  // A Claude subscription stored before Factory dropped Claude sign-in is refused by Mastra Code, so the
  // server reports it apart from the connection (`source` stays 'none'). It must still be listed, so the
  // person sees why Anthropic models fail and can remove it, and Anthropic must no longer offer sign-in.
  it('lists a stored Claude subscription as not usable, offers no Claude sign-in, and signs it out', async () => {
    const providers: ProviderInfo[] = [
      { provider: 'anthropic', source: 'none', userCredentialRefused: 'oauth' },
      { provider: 'openai', source: 'none', oauth: { supported: true, modes: ['device-code'] } },
    ];
    let signOutCalls = 0;
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ providers })),
      http.delete(`${PROVIDERS_URL}/anthropic/oauth`, () => {
        signOutCalls += 1;
        providers[0] = { provider: 'anthropic', source: 'none' };
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProviderList credentialScope="user" />);

    await screen.findByText('Anthropic');
    expect(within(rowFor('anthropic')).getByText('Not usable')).toBeInTheDocument();
    expect(within(rowFor('anthropic')).queryByText('Signed in')).not.toBeInTheDocument();

    const drawer = await openAddProvider(user);
    expect(within(drawer).getByText('Sign in with a subscription')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Sign in to OpenAI' })).toBeInTheDocument();
    expect(within(drawer).queryByText('Anthropic')).not.toBeInTheDocument();
    expect(within(drawer).getByText('1 more take an API key. Type to find one.')).toBeInTheDocument();
    await user.type(within(drawer).getByLabelText('Search providers'), 'anthropic');
    expect(within(drawer).getByText('Not usable')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Add API key for Anthropic' })).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Sign in to Anthropic' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add provider' })).not.toBeInTheDocument());

    await pickRowAction(user, 'anthropic', 'Sign out');

    await waitFor(() => expect(signOutCalls).toBe(1));
    await waitFor(() => expect(screen.queryByText('Anthropic')).not.toBeInTheDocument());
  });
});
