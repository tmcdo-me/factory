import { sandboxProcessesOf } from '@factory/agent-runtime';
import { SandboxNotReadyError } from '@mastra/core/workspace';
import { SpritesSandbox } from '@mastra/sprites';
import { describe, expect, it, vi } from 'vitest';

import { SpritesFactorySandbox, spriteNameFor, spriteProcesses } from './factory-sandbox';

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
