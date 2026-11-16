/**
 * fork(claude-agent): a host can refuse Claude subscription credentials for Mastra Code's model layer.
 *
 * Anthropic allows a Claude subscription (Pro/Max) to be used by Claude Code only. Mastra Factory runs
 * Claude Code itself (the Claude Agent runtime) for anyone who wants their subscription, so it calls
 * {@link refuseClaudeSubscriptionCredentials} at startup. From then on Mastra Code calls Anthropic models
 * with an Anthropic API key only:
 *
 * - a stored `anthropic` OAuth sign-in (the code-sdk's `{ type: 'oauth', access, refresh, expires }`, in
 *   `auth.json` or a host credential store) is never read for a model call, refreshed or sent anywhere;
 * - an "API key" that is really a subscription token (`sk-ant-oat…`, what `claude setup-token` prints),
 *   whether stored or in `ANTHROPIC_API_KEY`, is refused the same way;
 * - an `anthropic/*` model with no usable API key fails with {@link ClaudeSubscriptionRefusedError}
 *   instead of falling back to the subscription (Claude Max) provider.
 *
 * Off by default, so the TUI is unchanged.
 */
import type { AuthCredential } from './types.js';

/** Credential id of Anthropic sign-ins and keys. */
export const ANTHROPIC_CREDENTIAL_ID = 'anthropic';

/** Wire-stable `Error.name` (the server flattens errors to `{ name, message }`). */
export const CLAUDE_SUBSCRIPTION_REFUSED_ERROR = 'ClaudeSubscriptionRefusedError';

const CLAUDE_SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';

let refused = false;

/** Refuse (or, for tests, allow again) Claude subscription credentials in Mastra Code's model layer. */
export function refuseClaudeSubscriptionCredentials(refuse = true): void {
  refused = refuse;
}

export function isClaudeSubscriptionRefused(): boolean {
  return refused;
}

/** A Claude subscription OAuth token (`sk-ant-oat…`), which is not an API key whatever slot it sits in. */
export function isClaudeSubscriptionToken(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith(CLAUDE_SUBSCRIPTION_TOKEN_PREFIX);
}

/** Whether `credential`, stored for `provider`, is a Claude subscription credential (OAuth or token). */
export function isClaudeSubscriptionCredential(provider: string, credential: AuthCredential | undefined): boolean {
  if (provider !== ANTHROPIC_CREDENTIAL_ID || !credential) return false;
  return credential.type === 'oauth' || isClaudeSubscriptionToken(credential.key);
}

/** Whether model resolution must ignore this credential under the current policy. */
export function isRefusedCredential(provider: string, credential: AuthCredential | undefined): boolean {
  return refused && isClaudeSubscriptionCredential(provider, credential);
}

/** Whether model resolution must ignore this Anthropic key under the current policy. */
export function isRefusedAnthropicKey(key: string | undefined): boolean {
  return refused && isClaudeSubscriptionToken(key);
}

/**
 * Mastra Code was asked for an Anthropic model and has no Anthropic API key to call it with. Not a
 * `ProviderAuthRequiredError` on purpose: account rotation answers that one by refreshing the stored
 * sign-in, which here is the subscription credential Mastra Code must not touch.
 */
export class ClaudeSubscriptionRefusedError extends Error {
  readonly name = CLAUDE_SUBSCRIPTION_REFUSED_ERROR;

  constructor(modelId?: string) {
    super(
      `Mastra Code can't use a Claude subscription sign-in${modelId ? ` for ${modelId}` : ''}: it calls Anthropic models with an Anthropic API key only. Add a Claude API key for Anthropic, or run the session on Claude Agent to use your Claude subscription.`,
    );
  }
}
