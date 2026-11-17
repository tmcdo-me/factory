// fork(claude-agent)
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { claudeAgentRequestContext } from './claude-agent-workspace.js';
import { turnSession } from './turn-session.js';

describe('turnSession', () => {
  it("reads a Mastra Code turn's session and state from its controller context", () => {
    const context = new RequestContext();
    context.set('controller', {
      sessionId: 's1',
      resourceId: 'r1',
      threadId: 't1',
      workspace: { name: 'w' },
      getState: () => ({ factoryProjectId: 'p1' }),
    });
    const session = turnSession<{ factoryProjectId: string }>(context);
    expect(session).toMatchObject({ sessionId: 's1', resourceId: 'r1', threadId: 't1', workspace: { name: 'w' } });
    expect(session!.state()).toEqual({ factoryProjectId: 'p1' });
  });

  it("reads a Claude Agent turn's session the same way", async () => {
    const context = claudeAgentRequestContext('s2', { resourceId: 'r2' })(new RequestContext());
    const session = turnSession(context);
    expect(session).toMatchObject({ sessionId: 's2', resourceId: 'r2', threadId: 's2' });
    expect(session!.state()).toEqual({});
  });

  it('has no session without a controller, a session id, or a request context', () => {
    expect(turnSession(undefined)).toBeUndefined();
    expect(turnSession(new RequestContext())).toBeUndefined();
    const context = new RequestContext();
    context.set('controller', { resourceId: 'r', threadId: 't' });
    expect(turnSession(context)).toBeUndefined();
  });
});
