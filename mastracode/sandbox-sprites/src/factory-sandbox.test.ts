import { sandboxProcessesOf } from '@factory/agent-runtime';
import { SandboxNotReadyError } from '@mastra/core/workspace';
import { SpritesSandbox } from '@mastra/sprites';
import { describe, expect, it, vi } from 'vitest';

import { SpritesFactorySandbox, spriteNameFor, spriteProcesses } from './factory-sandbox';
import { execUrl, fakeSpriteExec } from './test-utils';

const ctx = (sessionId: string) => ({ sessionId, getRepositoryAccess: undefined });

describe('spriteNameFor', () => {
  it('names the Sprite from the session id, the same every time', () => {
    expect(spriteNameFor('s-01jabc')).toBe('factory-s-01jabc');
    expect(spriteNameFor('s-01jabc')).toBe(spriteNameFor('s-01jabc'));
    expect(spriteNameFor('abc', 'acme')).toBe('acme-abc');
  });

  it('makes any id a valid name, and keeps ids that clean up alike apart', () => {
    const names = ['Session_1', 'session-1', 'session 1', 'SESSION-1', 'x'.repeat(80), '../../etc'].map(id =>
      spriteNameFor(id),
    );
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('SpritesFactorySandbox', () => {
  it("creates each session's Sprite sandbox by name, without contacting Fly", () => {
    const factory = new SpritesFactorySandbox({
      token: 'fly-token',
      env: context => ({ ONLY_FOR: context.sessionId }),
      spriteConfig: { region: 'ord' },
    });
    const sandbox = factory.create(ctx('row-1'));
    expect(factory.provider).toBe('sprites');
    expect(sandbox).toBeInstanceOf(SpritesSandbox);
    expect(sandbox.id).toBe('factory-row-1');
    expect(sandbox.provider).toBe('sprites');
    expect(sandbox.getEnv()).toEqual({ ONLY_FOR: 'row-1' });
    expect(sandbox.status).toBe('pending');
  });

  it('offers long-lived processes, which need the Sprite started first', () => {
    const sandbox = new SpritesFactorySandbox({ token: 'fly-token' }).create(ctx('row-1'));
    const processes = sandboxProcessesOf(sandbox);
    expect(processes?.kind).toBe('sprite');
    expect(() => processes!.spawn('claude', [], { cwd: '/home/sprite/repo', env: {} })).toThrow(SandboxNotReadyError);
  });
});

describe('spriteProcesses files', () => {
  it("writes through the Sprite's filesystem API, creating parents and removing trees", async () => {
    const fs = {
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async (path: string) => {
        if (path === '/missing') throw new Error('ENOENT');
        return { isDirectory: () => path === '/dir' };
      }),
    };
    const sprite = { spawn: vi.fn(), filesystem: () => fs } as never;
    const { files } = spriteProcesses(() => sprite);

    await files.mkdir('/a/b');
    await files.rm('/a');
    await files.writeFile('/a/b/SKILL.md', 'text');
    await files.writeFile('/a/b/bin', new Uint8Array([1, 2]));
    expect(fs.mkdir).toHaveBeenCalledWith('/a/b', { recursive: true });
    expect(fs.rm).toHaveBeenCalledWith('/a', { recursive: true, force: true });
    expect(fs.writeFile).toHaveBeenCalledWith('/a/b/SKILL.md', 'text');
    expect(fs.writeFile).toHaveBeenLastCalledWith('/a/b/bin', Buffer.from([1, 2]));
    expect(await files.isDirectory('/dir')).toBe(true);
    expect(await files.isDirectory('/file')).toBe(false);
    expect(await files.isDirectory('/missing')).toBe(false);
  });
});

/**
 * A session's Sprite sandbox, started against a fake raw Sprite (local processes) instead of Fly:
 * the Sprite handle is the one `start()` would have fetched.
 */
async function startedSandbox(options: { failConnect?: string; prepare?: (order: string[]) => Promise<void> } = {}) {
  const raw = fakeSpriteExec(options.failConnect ? { failConnect: options.failConnect } : {});
  const order: string[] = [];
  const sandbox = new SpritesFactorySandbox({
    token: 'fly-token',
    ...(options.prepare ? { prepare: () => options.prepare!(order) } : {}),
  }).create(ctx('row-1'));
  (sandbox as unknown as { _sprite: unknown })._sprite = {
    name: 'factory-row-1',
    spawn: raw.spawn,
    filesystem: () => ({}),
    closeControlConnection: () => {},
  };
  sandbox.setOnStart(() => async () => {
    order.push('setup');
  });
  await sandbox.start();
  return { sandbox, raw, order };
}

describe('SessionSpritesSandbox', () => {
  const SECRET = 'ghs_project-secret-value';

  it("runs Factory's commands with the sandbox env over stdin, never in an exec URL", async () => {
    const { sandbox, raw } = await startedSandbox();
    sandbox.setEnv(env => ({ ...env, GH_TOKEN: SECRET, PROJECT_SECRET: 'multi\nline' }));

    const result = await sandbox.executeCommand!('printf "%s|%s" "$GH_TOKEN" "$PROJECT_SECRET"');
    expect(result).toMatchObject({ exitCode: 0, stdout: `${SECRET}|multi\nline` });
    expect(raw.requests).toHaveLength(1);
    expect(raw.requests[0]!.options).not.toHaveProperty('env');
    expect(execUrl(raw.requests[0]!)).not.toContain('ghs_');
    expect(execUrl(raw.requests[0]!)).not.toContain('multi');
  });

  it('keeps the exec URL (and so the secrets) out of a failed command', async () => {
    const { sandbox } = await startedSandbox({ failConnect: 'Unexpected server response: 502' });
    sandbox.setEnv(env => ({ ...env, GH_TOKEN: SECRET }));
    const failure = await sandbox.executeCommand!('git push').then(
      result => `${result.stdout}${result.stderr}`,
      (error: Error) => `${error.message}\n${error.stack}`,
    );
    expect(failure).toContain('Unexpected server response: 502');
    expect(failure).not.toMatch(/ghs_|wss:|git push|url:/);
  });

  it("prepares the Sprite before Factory's setup hook runs", async () => {
    const { order } = await startedSandbox({
      prepare: async seen => {
        seen.push('prepare');
      },
    });
    expect(order).toEqual(['prepare', 'setup']);
  });

  it('starts anyway when preparing fails (what it prepares is checked again where it is used)', async () => {
    const { order, sandbox } = await startedSandbox({
      prepare: async () => {
        throw new Error('curl: (6) Could not resolve host');
      },
    });
    expect(order).toEqual(['setup']);
    expect(sandbox.status).toBe('running');
  });

  it('kills the long-lived processes it started when it stops', async () => {
    const { sandbox, raw } = await startedSandbox();
    const processes = sandboxProcessesOf(sandbox)!;
    const claude = processes.spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: '/', env: {} });
    await new Promise(resolve => setTimeout(resolve, 200));
    const exit = new Promise(resolve => claude.once('exit', (code, signal) => resolve([code, signal])));
    await sandbox.stop();
    expect(await exit).toEqual([null, 'SIGKILL']);
    expect(raw.signals).toContain('SIGKILL');
  });
});
