// fork(claude-agent): slice 7l. Factory owns the live-session and controller types its dispatcher and start
// coordinator call (`@factory/agent-runtime`, `live-session.ts`); these compile-time checks fail the build when
// Mastra Code's controller drifts from them.
import type { RuntimeController, RuntimeLiveSession } from '@factory/agent-runtime';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController, Session } from '@mastra/core/agent-controller';
import { describe, expectTypeOf, it } from 'vitest';

describe('Factory-owned live session and controller types against the controller', () => {
  it("a controller session is structurally Factory's live session", () => {
    // Plain assignments, so a drift names the member (`toMatchTypeOf` only says "missing properties").
    const asLiveSession = (session: Session<MastraCodeState>): RuntimeLiveSession => session;
    const asController = (controller: AgentController<MastraCodeState>): RuntimeController<Session<MastraCodeState>> =>
      controller;
    expectTypeOf(asLiveSession).returns.toEqualTypeOf<RuntimeLiveSession>();
    expectTypeOf(asController).returns.toEqualTypeOf<RuntimeController<Session<MastraCodeState>>>();
  });
});
