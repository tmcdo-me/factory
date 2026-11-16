import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

import type { SpawnOptions } from '@fly/sprites';

import { stdinEnv } from './stdin-env';

/**
 * The part of `@fly/sprites`' `SpriteCommand` (a WebSocket exec session) Factory uses. It emits
 * `spawn` once the exec is connected (stdin written before then is lost), `exit` with the remote
 * exit status (`-1` when the connection closed without one), and `error`.
 */
export interface SpriteCommandLike {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<number>;
  kill(signal?: string): void;
  close(): void;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

/** What starts one exec in the Sprite (`sprite.spawn`). */
export type SpriteSpawn = (command: string, args?: string[], options?: SpawnOptions) => SpriteCommandLike;

/**
 * An error from the Sprites SDK, without what it may carry of the exec request. The SDK writes the
 * whole exec URL into its WebSocket errors (`… (url: wss://…?cmd=…&env=…)`): the command line,
 * `--settings` JSON and, for an exec that passed `env`, its values. The message is rebuilt (a
 * fresh stack, no `cause`) so nothing of the original travels on.
 */
export function redactSpriteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.replace(/\s*\(url: [^)\s]*\)/g, '').replace(/wss?:\/\/[^\s)'"]+/g, '<sprites exec>');
  const redacted = new Error(clean);
  if (error instanceof Error && error.name !== 'Error') redacted.name = error.name;
  return redacted;
}

/**
 * One exec started through {@link envOverStdin}: the real exec runs the `stdinEnv` script, and this
 * writes the preamble once it is connected, ahead of whatever the caller writes to `stdin` (held
 * until then). Errors are redacted; everything else is the real exec's.
 */
class StdinEnvCommand extends EventEmitter implements SpriteCommandLike {
  readonly stdin = new PassThrough();
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly #exec: SpriteCommandLike & { signal?(signal: string): void; exitCode?(): number };

  constructor(exec: SpriteCommandLike, preamble: string) {
    super();
    this.#exec = exec;
    this.stdout = exec.stdout;
    this.stderr = exec.stderr;
    exec.on('spawn', () => {
      exec.stdin.write(preamble);
      this.stdin.pipe(exec.stdin);
      this.emit('spawn');
    });
    exec.on('exit', code => this.emit('exit', code));
    exec.on('message', message => this.emit('message', message));
    // Always listened to on the real exec (an unhandled `error` would throw); passed on only redacted.
    exec.on('error', error => {
      if (this.listenerCount('error') > 0) this.emit('error', redactSpriteError(error));
    });
  }

  wait(): Promise<number> {
    return this.#exec.wait();
  }

  kill(signal?: string): void {
    this.#exec.kill(signal);
  }

  close(): void {
    this.#exec.close();
  }

  signal(signal: string): void {
    this.#exec.signal?.(signal);
  }

  exitCode(): number {
    return this.#exec.exitCode?.() ?? -1;
  }
}

/** The exec methods that bypass `spawn` and would put `env` in a URL. */
const BLOCKED = new Set(['exec', 'execFile', 'execFileHTTP']);

/**
 * The Sprite, with every exec's environment sent over stdin. `spawn(command, args, { env, cwd })`
 * runs `sh -c <stdinEnv script> command args…` with no `env` in the request; `exec`/`execFile`
 * (which would) are refused. Everything else (filesystem, checkpoints, delete) is the Sprite's own.
 */
export function envOverStdin<T extends { spawn: SpriteSpawn }>(sprite: T): T {
  const spawn: SpriteSpawn = (command, args = [], options = {}) => {
    const { env, ...rest } = options;
    const { script, preamble } = stdinEnv(env ?? {});
    return new StdinEnvCommand(sprite.spawn('sh', ['-c', script, command, ...args], rest), preamble);
  };
  return new Proxy(sprite, {
    get(target, property, receiver) {
      if (property === 'spawn') return spawn;
      if (typeof property === 'string' && BLOCKED.has(property)) {
        return () => {
          throw new Error(`Sprite.${property} is not used by Factory: commands run through spawn`);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
