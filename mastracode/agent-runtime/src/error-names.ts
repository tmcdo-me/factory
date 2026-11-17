// fork(claude-agent): slice 7i. Names Factory matches on that Mastra Code's package also defines. Factory owns the
// values so its error and credential code does not import that package; `runtime-mastra-code`'s
// `error-names.test.ts` pins each to the package's own constant.

/** `error.name` of a run that stopped because its provider needs a sign-in. */
export const PROVIDER_AUTH_REQUIRED_ERROR = 'ProviderAuthRequiredError';

/** `error.name` of a run refused because it would have used a Claude subscription sign-in outside Claude Code. */
export const CLAUDE_SUBSCRIPTION_REFUSED_ERROR = 'ClaudeSubscriptionRefusedError';

/** Prefix of a model id served by the Mastra Gateway. */
export const MASTRA_GATEWAY_PREFIX = 'mastra/';

/** The id of Mastra Code's agent, which Factory's boards name as their default runner. */
export const MASTRA_CODE_AGENT_ID = 'code-agent';
