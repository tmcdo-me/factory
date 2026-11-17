// fork(claude-agent): slice 7k. The Factory-owned workspace context types against Mastra Code's own.
import type { RuntimeSkillExtension, RuntimeWorkspaceContext, RuntimeWorkspaceSession } from '@factory/agent-runtime';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { getDynamicWorkspace, WorkspaceSkillExtension } from '@mastra/code-sdk/agents/workspace';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { mastraCodeWorkspaceBuilders } from './workspace-builders';

describe('Mastra Code workspace builders', () => {
  it('agree with the Factory-owned types', () => {
    expectTypeOf<WorkspaceSkillExtension>().toEqualTypeOf<RuntimeSkillExtension>();
    // The resolver Factory builds is called with Mastra Code's context, which must satisfy ours.
    expectTypeOf<Parameters<typeof getDynamicWorkspace>[0]>().toMatchTypeOf<RuntimeWorkspaceContext>();
    expectTypeOf<AgentControllerRequestContext<MastraCodeState>>().toMatchTypeOf<RuntimeWorkspaceSession>();
  });

  it("builds the tools with plans under the given directory and keeps Mastra Code's config directory", () => {
    expect(mastraCodeWorkspaceBuilders.configDir).toBe('.mastracode');
    expect(mastraCodeWorkspaceBuilders.workspaceTools('.artifacts/plans')).toBeTruthy();
  });
});
