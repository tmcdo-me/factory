import { providerDisplayName } from '@mastra/factory/provider-display-name';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect } from 'vitest';

import { server } from '../../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL } from '../../../../../../../../e2e/ui/render';
import type { OAuthStartResponse, ProviderInfo } from '../../../../../../../api/types';

export const PROVIDERS_URL = `${TEST_BASE_URL}/web/config/providers`;
export const keyUrl = (provider: string) => `${PROVIDERS_URL}/${encodeURIComponent(provider)}/key`;
export const oauthUrl = (provider: string, action: 'start' | 'poll') =>
  `${PROVIDERS_URL}/${encodeURIComponent(provider)}/oauth/${action}`;

// fork(claude-agent): every web sign-in is a device-code flow now that the Anthropic paste-code sign-in is gone.
export const deviceCodeSession = (sessionId: string, userCode = 'ABCD-1234', nextPollMs = 10): OAuthStartResponse => ({
  sessionId,
  kind: 'device-code',
  url: 'https://example.com/device',
  userCode,
  instructions: 'Enter this code.',
  expiresAt: Date.now() + 60_000,
  nextPollMs,
});

/** Answers the dialog's first poll with a completed sign-in, after `onComplete` updates the server state. */
export function completeOnPoll(provider: string, onComplete: () => void) {
  server.use(
    http.post(oauthUrl(provider, 'poll'), () => {
      onComplete();
      return HttpResponse.json({ status: 'complete', ok: true });
    }),
  );
}

export function stubProviders(providers: ProviderInfo[], orgKeyAdmin?: boolean) {
  server.use(http.get(PROVIDERS_URL, () => HttpResponse.json({ providers, orgKeyAdmin })));
}

export function rowFor(provider: string, container: HTMLElement = document.body): HTMLElement {
  const row = within(container).getByText(providerDisplayName(provider)).closest('li');
  if (!(row instanceof HTMLElement)) throw new Error(`Provider row not found for ${provider}`);
  return row;
}

export async function openAddProvider(user: UserEvent, container: HTMLElement = document.body) {
  const add = await within(container).findByRole('button', { name: 'Add provider' });
  await waitFor(() => expect(add).toBeEnabled());
  await user.click(add);
  return screen.findByRole('dialog', { name: 'Add provider' });
}

export async function saveKey(user: UserEvent, key: string) {
  await user.type(await screen.findByPlaceholderText('Paste API key'), key);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

export async function pickRowAction(
  user: UserEvent,
  provider: string,
  action: string,
  container: HTMLElement = document.body,
) {
  const trigger = within(rowFor(provider, container)).getByRole('button', {
    name: `${providerDisplayName(provider)} actions`,
  });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: action }));
}
