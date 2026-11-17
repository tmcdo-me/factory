// fork(claude-agent): slice 7h. Factory owns the session types its code reads (`@factory/agent-runtime`,
// `session-surface.ts`); these compile-time checks fail the build when Mastra Code's controller drifts from them.
import type {
  RuntimeKnownSessionEvent,
  RuntimeRequestContext,
  RuntimeSessionEvents,
  RuntimeSessionState,
  RuntimeSessionStateAccess,
  RuntimeThread,
  RuntimeThreadQueries,
} from '@factory/agent-runtime';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type {
  AgentController,
  AgentControllerEvent,
  AgentControllerRequestContext,
  AgentControllerThread,
  Session,
} from '@mastra/core/agent-controller';
import { describe, expectTypeOf, it } from 'vitest';

describe('Factory-owned session types against the controller', () => {
  it("threads, events, state and request context are structurally the controller's", () => {
    expectTypeOf<AgentControllerThread>().toMatchTypeOf<RuntimeThread>();
    expectTypeOf<RuntimeKnownSessionEvent>().toMatchTypeOf<AgentControllerEvent>();
    expectTypeOf<AgentControllerEvent>().toMatchTypeOf<{ type: string }>();
    expectTypeOf<Session<MastraCodeState>>().toMatchTypeOf<RuntimeSessionEvents>();
    expectTypeOf<Pick<AgentController<MastraCodeState>, 'queryThreads' | 'queryThreadById'>>().toMatchTypeOf<
      RuntimeThreadQueries<AgentControllerThread>
    >();
    expectTypeOf<Session<MastraCodeState>['state']>().toMatchTypeOf<RuntimeSessionStateAccess>();
    expectTypeOf<MastraCodeState>().toMatchTypeOf<RuntimeSessionState>();
    expectTypeOf<AgentControllerRequestContext<MastraCodeState>>().toMatchTypeOf<
      RuntimeRequestContext<MastraCodeState>
    >();
  });
});
