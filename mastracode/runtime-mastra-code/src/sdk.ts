// fork(claude-agent): the Mastra Code SDK surface Factory's server code still uses, owned by the adapter package.
// Factory source outside this package may not import `@mastra/code-sdk` (spec section 5, seam-import lint); the
// routes reach these utilities here instead, so moving or replacing the adapter touches one file. Re-exports only,
// no behaviour of its own. Grouped by the route that needs them; slice 7 narrows each group to an injected
// capability at the composition root.

// routes/config, routes/provider-credentials
export type { CredentialTenant } from '@mastra/code-sdk/agents/credential-resolver';
export { MastraCodeGateway } from '@mastra/code-sdk/agents/mastracode-gateway';
export type { MastraCodeCustomProvider } from '@mastra/code-sdk/agents/mastracode-gateway';
export { isClaudeSubscriptionCredential } from '@mastra/code-sdk/auth/claude-subscription-policy';
export type { AuthStorage } from '@mastra/code-sdk/auth/storage';
export { MIN_OBSERVATION_THRESHOLD } from '@mastra/code-sdk/constants';
export { resolveAutoOMModelId } from '@mastra/code-sdk/onboarding/packs';
export type { ProviderAccess, ProviderAccessLevel } from '@mastra/code-sdk/onboarding/packs';
export { getCustomProviderId, MASTRA_GATEWAY_PROVIDER } from '@mastra/code-sdk/onboarding/settings';
export type { CustomProviderSetting } from '@mastra/code-sdk/onboarding/settings';
export { AMAZON_BEDROCK_GATEWAY_ID } from '@mastra/code-sdk/providers/amazon-bedrock-gateway';
export { GOOGLE_VERTEX_GATEWAY_ID } from '@mastra/code-sdk/providers/google-vertex-gateway';
export {
  getCredentialProviderId,
  MASTRA_GATEWAY_PREFIX,
  normalizeLegacyProviderId,
} from '@mastra/code-sdk/providers/model-ids';

// routes/custom-provider-source
export {
  resolveAuthenticatedCredentialTenant,
  resolveCredentialStore,
  resolveTenantFromRequestContext,
} from '@mastra/code-sdk/agents/credential-resolver';
export { setCustomProvidersSource } from '@mastra/code-sdk/agents/custom-provider-source';

// routes/fs
export { SandboxFilesystem } from '@mastra/code-sdk/agents/sandbox-filesystem';
export { detectProject, getResourceIdOverride } from '@mastra/code-sdk/utils/project';

// routes/source-control-sessions
export type { MountedMastraCode } from '@mastra/code-sdk';
export { resolveModel, resolveRequestThinkingLevel } from '@mastra/code-sdk/agents/model';

// routes/oauth, routes/tenant-credentials, routes/voice, voice/transcription, storage credentials, auth.ts, routes/skills, routes/surface, skills/service (controller and SDK types)
export type { AgentController, MessageAuthor } from '@mastra/core/agent-controller';
export { nextPollDelayMs } from '@mastra/code-sdk/auth/device-code';
export {
  copilotNextPollDelayMs,
  pollGitHubCopilotDeviceLogin,
  startGitHubCopilotDeviceLogin,
} from '@mastra/code-sdk/auth/providers/github-copilot';
export type { CopilotDeviceLoginPending } from '@mastra/code-sdk/auth/providers/github-copilot';
export { pollCodexDeviceLogin, startCodexDeviceLogin } from '@mastra/code-sdk/auth/providers/openai-codex';
export type { CodexDeviceLoginPending } from '@mastra/code-sdk/auth/providers/openai-codex';
export { pollXAIDeviceLogin, startXAIDeviceLogin } from '@mastra/code-sdk/auth/providers/xai';
export type { XAIDeviceLoginPending } from '@mastra/code-sdk/auth/providers/xai';
export type { AuthCredential, CredentialStore, OAuthCredential, OAuthCredentials } from '@mastra/code-sdk/auth/types';
export type { MastraCodeState } from '@mastra/code-sdk/schema';
export type { CredentialTenantResolver } from '@mastra/code-sdk/agents/credential-resolver';
export { prepareCredentialTenant, setCredentialStoreProvider } from '@mastra/code-sdk/agents/credential-resolver';
export { PROVIDER_DEFAULT_MODELS, getOAuthProvider } from '@mastra/code-sdk/auth/storage';
export { STT_MODELS, findSTTModel, resolveSTTModel, sttProviders } from '@mastra/code-sdk/voice/stt-registry';
export type { STTModel } from '@mastra/code-sdk/voice/stt-registry';
export { createSTTTranscriber, resolveSTTApiKey, sttApiKeyEnvVar } from '@mastra/code-sdk/voice/transcribe';

// integrations/slack
export { migratePersistedModelSelection } from '@mastra/core/agent-controller';

// factory.ts, integrations/base.ts: mounting, memory, MCP and credential-policy hooks used by the composition root
export type { MastraCodeConfig } from '@mastra/code-sdk';
export { prepareAgentControllerMount } from '@mastra/code-sdk';
export { getDynamicMemory } from '@mastra/code-sdk/agents/memory';
export { refuseClaudeSubscriptionCredentials } from '@mastra/code-sdk/auth/claude-subscription-policy';
export { getGlobalMcpPath } from '@mastra/code-sdk/mcp/config';
export type { AgentControllerRequestContext, BuiltinToolId } from '@mastra/core/agent-controller';
