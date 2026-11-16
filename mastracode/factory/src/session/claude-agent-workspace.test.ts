// fork(claude-agent)
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { SANDBOX_PROCESSES } from '@factory/agent-runtime';
import type { SandboxProcesses } from '@factory/agent-runtime';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkspaceSandbox } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * A started Sprite sandbox as Factory's workspace hands it out: its checkout lives in the VM (not
 * on this host), and it carries the seam's processes. Commands record what they run.
 */
/** A process that exits at once with no output, as a stand-in for the install exec. */
function fakeProcess() {
  const process = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(process, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  setTimeout(() => {
    (process.stdout as PassThrough).end();
    process.emit('exit', 0, null);
  }, 5);
  return process;
}

function spriteSandbox(options: { checkout?: boolean } = {}) {
  const commands: string[] = [];
  const spawn = vi.fn();
  const processes: SandboxProcesses = {
    kind: 'sprite',
    spawn,
    files: {
      mkdir: async () => {},
      rm: async () => {},
      writeFile: async () => {},
      isDirectory: async path => options.checkout !== false && path === '/home/sprite/repo',
    },
  };
  const sandbox = {
    id: 'factory-row-1',
    provider: 'sprites',
    status: 'running',
    ensureRunning: async () => {},
    getEnv: (): Record<string, string> => ({ GH_TOKEN: 'ghs_x' }),
    executeCommand: vi.fn(async (command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    [SANDBOX_PROCESSES]: processes,
  };
  const entry = getSessionSandbox('row-1', 'acme/repo', () => sandbox as unknown as WorkspaceSandbox);
  entry.workdir = '/home/sprite/repo'; // the start hook's probe, as after the clone
  return { sandbox, processes, spawn, commands };
}

const installed = {
  version: '2.1.325',
  home: '/home/sprite/.factory/claude-agent',
  executable: '/home/sprite/.factory/claude-agent/.local/share/claude/versions/2.1.325',
  checksum: 'c'.repeat(64),
};

describe('Claude Agent workspace', () => {
  it("runs Claude Code inside a Sprite: installed and verified there, launched through the sandbox's processes", async () => {
    const { sandbox, spawn } = spriteSandbox();
    const scripts: string[] = [];
    const install = vi.fn(async (run: (script: string) => Promise<unknown>) => {
      scripts.push('install');
      void run;
      return installed;
    });
    const resolve = createClaudeAgentWorkspaceResolver({
      resolveWorkspace: async () => ({ sandbox }) as never,
      getMastra: () => undefined,
      installClaudeCode: install,
    });

    const workspace = await resolve('agent-session-1', undefined);
    expect(workspace).toMatchObject({
      cwd: '/home/sprite/repo',
      env: { GH_TOKEN: 'ghs_x' },
      launch: { home: installed.home, remote: true, pathToClaudeCodeExecutable: installed.executable },
      sessionWorkspace: { kind: 'sprite', checkoutDir: '/home/sprite/repo' },
    });

    // Claude Code starts through the Sprite, never as a process on this host, behind the launch check.
    workspace.launch!.spawnClaudeCodeProcess!({
      command: installed.executable,
      args: ['--resume', 'claude-1'],
      cwd: '/home/sprite/repo',
      env: { HOME: installed.home },
    });
    expect(spawn).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining(installed.checksum), 'claude', '--resume', 'claude-1'],
      {
        cwd: '/home/sprite/repo',
        env: { HOME: installed.home },
        signal: undefined,
      },
    );

    // Every open checks again: after a reset the same sandbox object is a new VM without the binary.
    await resolve('agent-session-1', undefined);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("with Claude Code's Bash sandbox, makes the Sprite ready for it and launches behind its check", async () => {
    const { sandbox, spawn } = spriteSandbox();
    const order: string[] = [];
    const resolve = createClaudeAgentWorkspaceResolver({
      resolveWorkspace: async () => ({ sandbox }) as never,
      getMastra: () => undefined,
      installClaudeCode: async () => {
        order.push('claude-code');
        return installed;
      },
      installBashSandbox: async () => {
        order.push('bash-sandbox');
      },
    });
    const launchScript = async (bashSandbox: boolean | undefined) => {
      spawn.mockClear();
      const workspace = await resolve('agent-session-1', undefined, bashSandbox === undefined ? {} : { bashSandbox });
      workspace.launch!.spawnClaudeCodeProcess!({ command: installed.executable, args: [], env: {} });
      return spawn.mock.calls[0]![1][1] as string;
    };
    expect(await launchScript(true)).toMatch(/Bash sandbox can't run in this sandbox/);
    expect(order).toEqual(['claude-code', 'bash-sandbox']);
    // Off (a trusted session opted out): neither the install nor the check.
    order.length = 0;
    expect(await launchScript(false)).not.toMatch(/Bash sandbox/);
    expect(await launchScript(undefined)).not.toMatch(/Bash sandbox/);
    expect(order).toEqual(['claude-code', 'claude-code']);
  });

  it('installs through the sandbox processes with no environment, never through a command with the sandbox env', async () => {
    const { sandbox, spawn } = spriteSandbox();
    const resolve = createClaudeAgentWorkspaceResolver({
      resolveWorkspace: async () => ({ sandbox }) as never,
      getMastra: () => undefined,
      installClaudeCode: async run => {
        void run('the install script');
        return installed;
      },
    });
    spawn.mockReturnValue(fakeProcess());
    await resolve('agent-session-1', undefined);
    expect(spawn).toHaveBeenCalledWith('sh', ['-c', 'the install script'], expect.objectContaining({ env: {} }));
    expect(sandbox.executeCommand).not.toHaveBeenCalledWith('the install script', expect.anything(), expect.anything());
  });

  it("reads the sandbox env afresh, after Factory's per-command token refresh, whenever Claude Code starts", async () => {
    const { sandbox } = spriteSandbox();
    let token = 'ghs_old';
    sandbox.getEnv = () => ({ GH_TOKEN: token });
    sandbox.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'true') token = 'ghs_fresh'; // what the refresh before a command does
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const workspace = await createClaudeAgentWorkspaceResolver({
      resolveWorkspace: async () => ({ sandbox }) as never,
      getMastra: () => undefined,
      installClaudeCode: async () => installed,
    })('agent-session-1', undefined);
    expect(workspace.env).toEqual({ GH_TOKEN: 'ghs_old' });
    expect(await workspace.freshEnv!()).toEqual({ GH_TOKEN: 'ghs_fresh' });
  });

  it('tries the install again on the next open when it failed', async () => {
    const { sandbox } = spriteSandbox();
    const install = vi
      .fn()
      .mockRejectedValueOnce(new Error('curl: (6) Could not resolve host'))
      .mockResolvedValue(installed);
    const resolve = createClaudeAgentWorkspaceResolver({
      resolveWorkspace: async () => ({ sandbox }) as never,
      getMastra: () => undefined,
      installClaudeCode: install,
    });
    await expect(resolve('agent-session-1', undefined)).rejects.toThrow(/Could not resolve host/);
    await expect(resolve('agent-session-1', undefined)).resolves.toMatchObject({ launch: { home: installed.home } });
  });

  it("checks a Sprite's checkout in the Sprite, not on this host", async () => {
    const { sandbox } = spriteSandbox({ checkout: false });
    const resolve = createClaudeAgentWorkspaceResolver({
      resolveWorkspace: async () => ({ sandbox }) as never,
      getMastra: () => undefined,
      installClaudeCode: async () => installed,
    });
    await expect(resolve('agent-session-1', undefined)).rejects.toThrow(/checkout is not ready/);
  });

  it("refuses a sandbox that can't run Claude Code", async () => {
    const sandbox = { id: 'e2b-1', provider: 'e2b', ensureRunning: async () => {} };
    await expect(resolverFor(sandbox)('agent-session-1', undefined)).rejects.toThrow(
      /need a local or Sprites sandbox.*not e2b/,
    );
  });

  it('runs a local sandbox on this host, as before: no install, no launch', async () => {
    const { sandbox, finishClone } = startingSandbox();
    await finishClone();
    const workspace = await resolverFor(sandbox)('agent-session-1', undefined);
    expect(workspace.launch).toBeUndefined();
    expect(workspace.sessionWorkspace).toMatchObject({ kind: 'local', checkoutDir: join(root, 'row-1', 'repo') });
  });

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
