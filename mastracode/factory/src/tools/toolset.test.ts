// fork(claude-agent): the context Factory's tool definitions get (slice 4).
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { mastraCodeToolContext, mastraSessionWorkspace, scopeToolContext } from './toolset.js';

function turn(ids: { sessionId: string; threadId: string }, user = 'user-1') {
  const context = new RequestContext();
  context.set('user', { workosId: user, organizationId: 'org-1' });
  context.set('controller', { ...ids, resourceId: ids.sessionId });
  return context;
}

describe('mastraCodeToolContext', () => {
  const own = { sessionId: 's1', threadId: 't1' };

  it("acts as the turn's session and caller, with Mastra's call id", async () => {
    const context = mastraCodeToolContext(turn(own));
    const ctx = await context({ toolName: 'factory_probe', callId: 'call-1', requestContext: turn(own) });
    expect(ctx).toMatchObject({ sessionId: 's1', callId: 'call-1', orgId: 'org-1', userId: 'user-1' });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives a call without a tool call id an empty one, never one of its own', async () => {
    const ctx = await mastraCodeToolContext(turn(own))({ toolName: 'factory_transition_work_item' });
    expect(ctx.callId).toBe('');
  });

  it("refuses a call that brings another session's or thread's request context", () => {
    const context = mastraCodeToolContext(turn(own));
    for (const other of [
      { sessionId: 's1', threadId: 'other-thread' },
      { sessionId: 'other-session', threadId: 't1' },
    ]) {
      expect(() => context({ toolName: 'factory_transition_work_item', requestContext: turn(other) })).toThrow(
        /built for another session or thread/,
      );
    }
  });

  it("lets a call whose context names no session act for the tools' own turn", async () => {
    const ctx = await mastraCodeToolContext(turn(own))({
      toolName: 'factory_probe',
      requestContext: new RequestContext(),
    });
    expect(ctx).toMatchObject({ sessionId: 's1', userId: 'user-1', callId: '' });
  });
});

describe("a Mastra Code call's session workspace", () => {
  const own = { sessionId: 's1', threadId: 't1' };

  it('is built only when a tool reads it, once, from the agent workspace', async () => {
    let reads = 0;
    const sandbox = { provider: 'local', executeCommand: async () => ({}) };
    const agentWorkspace = {
      get sandbox() {
        reads++;
        return sandbox;
      },
    };
    const ctx = await mastraCodeToolContext(turn(own))({ toolName: 'x', workspace: agentWorkspace as never });
    expect(reads).toBe(0);
    expect(ctx.workspace?.sandbox).toBe(sandbox);
    expect(ctx.workspace?.kind).toBe('local');
    expect(reads).toBe(1);
    const none = await mastraCodeToolContext(turn(own))({ toolName: 'x' });
    expect(none.workspace).toBeUndefined();
  });

  it('is built from a filesystem alone, with no sandbox', () => {
    const filesystem = { stat: async () => ({}) };
    expect(mastraSessionWorkspace({ filesystem })).toMatchObject({ kind: 'remote', filesystem });
    expect(mastraSessionWorkspace({ filesystem })?.sandbox).toBeUndefined();
    expect(mastraSessionWorkspace({})).toBeUndefined();
  });

  it("is `remote` for a provider that launches no processes, and can't spawn there", () => {
    const workspace = mastraSessionWorkspace({ sandbox: { provider: 'platform' } });
    expect(workspace?.kind).toBe('remote');
    expect(() => workspace!.spawn('claude', [], { cwd: '/', env: {} })).toThrow(/cannot launch processes/);
  });
});

describe('scopeToolContext', () => {
  it("gives each MCP client call an id of its own, as the scope's session and caller", async () => {
    const context = scopeToolContext({ sessionId: 'connector', orgId: 'org-1', userId: 'user-1' });
    const [first, second] = await Promise.all([context({ toolName: 'x' }), context({ toolName: 'x' })]);
    expect(first).toMatchObject({ sessionId: 'connector', orgId: 'org-1', userId: 'user-1' });
    expect(first.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.callId).not.toBe(first.callId);
  });
});
