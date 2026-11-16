// fork(claude-agent)
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestContext } from '@mastra/core/request-context';
import type { WorkspaceSandbox } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __clearSessionSandboxesForTests, getSessionSandbox } from '../sandbox/session-sandbox.js';
import { claudeAgentRequestContext, createClaudeAgentWorkspaceResolver } from './claude-agent-workspace.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-workspace-'));
});
afterEach(async () => {
  __clearSessionSandboxesForTests();
  await rm(root, { recursive: true, force: true });
});

/**
 * A local sandbox the way Factory's eager start leaves it: already reporting `running`, its start hook
 * (the clone) still in flight. `finishClone` makes the checkout appear and settles the start.
 */
function startingSandbox() {
  let finishClone!: () => Promise<void>;
  const sandbox = {
    id: 'sb-1',
    provider: 'local',
    workingDirectory: join(root, 'row-1'),
    status: 'running',
    ensureRunning: async () => {}, // already `running`: returns at once
    getEnv: () => ({ GH_TOKEN: 'ghs_x', UNSET: undefined }),
    _startPromise: undefined as Promise<void> | undefined,
  };
  sandbox._startPromise = new Promise<void>(resolve => {
    finishClone = async () => {
      await mkdir(join(root, 'row-1', 'repo'), { recursive: true });
      resolve();
    };
  });
  // The memo is keyed by the source-control session row id, not the agent session id.
  const entry = getSessionSandbox('row-1', 'acme/repo', () => sandbox as unknown as WorkspaceSandbox);
  return { sandbox, entry, finishClone };
}

const resolverFor = (sandbox: unknown) =>
  createClaudeAgentWorkspaceResolver({
    resolveWorkspace: async () => ({ sandbox }) as never,
    getMastra: () => undefined,
  });

describe('Claude Agent workspace', () => {
  it('waits for a start still cloning before handing out the checkout', async () => {
    const { sandbox, entry, finishClone } = startingSandbox();
    let resolved = false;
    const pending = resolverFor(sandbox)('agent-session-1', undefined).then(result => {
      resolved = true;
      return result;
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(resolved).toBe(false); // regression: Claude Code was spawned into a missing directory

    await finishClone();
    expect(await pending).toMatchObject({ cwd: entry.workdir, env: { GH_TOKEN: 'ghs_x' } });
  });

  it('refuses a checkout that is still missing once the sandbox has started', async () => {
    const { sandbox } = startingSandbox();
    sandbox._startPromise = Promise.resolve();
    await expect(resolverFor(sandbox)('agent-session-1', undefined)).rejects.toThrow(/checkout is not ready/);
  });

  it("gives each turn's tools the caller's context and the session's one controller", async () => {
    const contextFor = claudeAgentRequestContext('agent-session-1');
    const first = new RequestContext();
    first.set('user', { workosId: 'user-a' });
    const second = new RequestContext();
    second.set('user', { workosId: 'user-b' });

    const a = contextFor(first);
    const b = contextFor(second);
    expect(a.get('user')).toEqual({ workosId: 'user-a' });
    expect(b.get('user')).toEqual({ workosId: 'user-b' });
    const controller = a.get('controller') as {
      sessionId: string;
      getState(): Record<string, unknown>;
      setState(updates: Record<string, unknown>): Promise<void>;
    };
    expect(controller).toMatchObject({ sessionId: 'agent-session-1', threadId: 'agent-session-1' });
    // What one turn's tool heals (e.g. a recovered binding's project) the next turn still sees.
    await controller.setState({ factoryProjectId: 'p1' });
    expect((b.get('controller') as typeof controller).getState()).toEqual({ factoryProjectId: 'p1' });
    expect(first.get('controller')).toBeUndefined(); // the host's own context is left alone
  });
});
