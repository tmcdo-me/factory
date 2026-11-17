// fork(claude-agent): slice 7i. Factory owns these names (`@factory/agent-runtime`, `error-names.ts`); they must
// equal the values Mastra Code's package raises and matches on.
import {
  CLAUDE_SUBSCRIPTION_REFUSED_ERROR,
  MASTRA_CODE_AGENT_ID,
  MASTRA_GATEWAY_PREFIX,
  PROVIDER_AUTH_REQUIRED_ERROR,
} from '@factory/agent-runtime';
import { CLAUDE_SUBSCRIPTION_REFUSED_ERROR as SDK_REFUSED } from '@mastra/code-sdk/auth/claude-subscription-policy';
import { PROVIDER_AUTH_REQUIRED_ERROR as SDK_AUTH } from '@mastra/code-sdk/auth/provider-auth-error';
import { CODE_AGENT_ID } from '@mastra/code-sdk/constants';
import { MASTRA_GATEWAY_PREFIX as SDK_PREFIX } from '@mastra/code-sdk/providers/model-ids';
import { describe, expect, it } from 'vitest';

describe('Factory-owned names against Mastra Code', () => {
  it('match the values the package defines', () => {
    expect(PROVIDER_AUTH_REQUIRED_ERROR).toBe(SDK_AUTH);
    expect(CLAUDE_SUBSCRIPTION_REFUSED_ERROR).toBe(SDK_REFUSED);
    expect(MASTRA_GATEWAY_PREFIX).toBe(SDK_PREFIX);
    expect(MASTRA_CODE_AGENT_ID).toBe(CODE_AGENT_ID);
  });
});
