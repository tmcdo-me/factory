// fork(claude-agent): slice 7j. Factory owns the turn controller shape (`@factory/agent-runtime`,
// `turn-controller.ts`); the build fails when Mastra Code's request context drifts from it.
import type { RuntimeTurnController } from '@factory/agent-runtime';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import { describe, expectTypeOf, it } from 'vitest';

describe('Factory-owned turn controller against the controller', () => {
  it('is what the controller request context carries', () => {
    expectTypeOf<AgentControllerRequestContext<MastraCodeState>>().toMatchTypeOf<RuntimeTurnController>();
  });
});
