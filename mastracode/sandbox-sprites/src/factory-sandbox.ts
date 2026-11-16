import { createHash } from 'node:crypto';

import { SANDBOX_PROCESSES } from '@factory/agent-runtime';
import type { ProcessSandbox, SandboxFiles, SandboxProcesses } from '@factory/agent-runtime';
import type { Sprite, SpriteConfig } from '@fly/sprites';
import { FactorySandbox } from '@mastra/core/workspace';
import type { FactorySandboxContext } from '@mastra/core/workspace';
import { SpritesSandbox } from '@mastra/sprites';
import type { SpritesSandboxOptions } from '@mastra/sprites';

import { spawnInSprite } from './sprite-process';

export interface SpritesFactorySandboxOptions {
  /** Sprites API token (the organization's). Falls back to `SPRITES_TOKEN`. */
  token?: string;
  /** Sprites API base URL; the SDK default (`https://api.sprites.dev`) when absent. */
  baseURL?: string;
  /** Machine settings applied when a session's Sprite is created (region, CPUs, RAM, storage). */
  spriteConfig?: SpriteConfig;
  /** Prefix of every session's Sprite name. Default `factory`. */
  namePrefix?: string;
  /** Default command timeout in milliseconds. */
  timeout?: number;
  /**
   * Environment of every session's commands. A function receives each session's context, so a
   * credential can go to one factory's sessions only. Factory adds the session's git credentials.
   */
  env?: Record<string, string> | ((ctx: FactorySandboxContext) => Record<string, string>);
}

/** Sprite names: lowercase letters, digits and dashes, starting with a letter. */
const MAX_NAME = 63;

/**
 * The Sprite a session runs in, named from its session id: the same session always gets the same
 * Sprite, so a restart or another replica reattaches to its disk (checkout, Claude transcripts).
 * An id that isn't a valid name as it is gets a hash of the original, so two ids never collide.
 */
export function spriteNameFor(sessionId: string, prefix = 'factory'): string {
  const cleaned = `${prefix}-${sessionId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-$/, '');
  if (cleaned === `${prefix}-${sessionId}` && cleaned.length <= MAX_NAME) return cleaned;
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 10);
  return `${cleaned.slice(0, MAX_NAME - hash.length - 1).replace(/-$/, '')}-${hash}`;
}

/**
 * Factory's sandbox on Fly.io Sprites: every session gets its own Sprite (a Firecracker VM with a
 * persistent disk that hibernates when idle), created on its first start and found again by name.
 * Factory clones the session's repositories into it as for any remote sandbox. Its sandboxes also
 * run long-lived stdio processes (`SANDBOX_PROCESSES`), which is how Claude Agent runs Claude Code
 * inside the Sprite.
 */
export class SpritesFactorySandbox extends FactorySandbox<Record<string, never>> {
  readonly provider = 'sprites';
  readonly #options: SpritesFactorySandboxOptions;

  constructor(options: SpritesFactorySandboxOptions = {}) {
    super();
    this.#options = options;
  }

  create(ctx: FactorySandboxContext): SessionSpritesSandbox {
    const { env, namePrefix, token, baseURL, spriteConfig, timeout } = this.#options;
    return new SessionSpritesSandbox({
      id: spriteNameFor(ctx.sessionId, namePrefix),
      ...(token ? { token } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(spriteConfig ? { spriteConfig } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(env ? { env: typeof env === 'function' ? env(ctx) : env } : {}),
      ...(ctx.workingDirectory ? { workingDirectory: ctx.workingDirectory } : {}),
    });
  }
}

/** A session's Sprite, with long-lived stdio processes and files for runtimes that run inside it. */
export class SessionSpritesSandbox extends SpritesSandbox implements ProcessSandbox {
  #processes: SandboxProcesses | undefined;

  constructor(options: SpritesSandboxOptions) {
    super(options);
  }

  /** Needs a started sandbox: the Sprite is looked up (or created) by `start()`. */
  get [SANDBOX_PROCESSES](): SandboxProcesses {
    this.#processes ??= spriteProcesses(() => this.sprite);
    return this.#processes;
  }
}

/** Processes and files in a Sprite, through its exec and filesystem APIs. */
export function spriteProcesses(sprite: () => Pick<Sprite, 'spawn' | 'filesystem'>): SandboxProcesses {
  return {
    kind: 'sprite',
    spawn: (command, args, options) =>
      spawnInSprite((cmd, cmdArgs, spawnOptions) => sprite().spawn(cmd, cmdArgs, spawnOptions), command, args, options),
    files: spriteFiles(() => sprite().filesystem()),
  };
}

function spriteFiles(fs: () => ReturnType<Sprite['filesystem']>): SandboxFiles {
  return {
    mkdir: path => fs().mkdir(path, { recursive: true }),
    rm: path => fs().rm(path, { recursive: true, force: true }),
    writeFile: (path, content) => fs().writeFile(path, typeof content === 'string' ? content : Buffer.from(content)),
    isDirectory: path =>
      fs()
        .stat(path)
        .then(
          stats => stats.isDirectory(),
          () => false,
        ),
  };
}
