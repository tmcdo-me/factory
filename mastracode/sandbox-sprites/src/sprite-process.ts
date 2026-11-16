import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import type { SandboxProcess, SpawnInSandboxOptions } from '@factory/agent-runtime';

import type { SpriteCommandLike, SpriteSpawn } from './sprite-exec';

/**
 * Start `command` in the Sprite as a long-lived process with stdio, shaped like the Agent SDK's
 * `SpawnedProcess` (and the seam's `SandboxProcess`), so a runtime talks to it exactly as to a local
 * child process. `spawn` must be the Sprite's {@link envOverStdin} spawn: the environment then goes
 * over stdin, never in the exec request.
 */
export function spawnInSprite(
  spawn: SpriteSpawn,
  command: string,
  args: string[],
  options: SpawnInSandboxOptions,
): SpriteStdioProcess {
  return new SpriteStdioProcess(spawn(command, args, { cwd: options.cwd, env: options.env }), options.signal);
}

/**
 * A Sprite exec as a child process. `kill` signals the remote process, and `SIGKILL` also drops the
 * connection, which makes the Sprite reap it.
 */
export class SpriteStdioProcess extends EventEmitter implements SandboxProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly #exec: SpriteCommandLike;
  #exitCode: number | null = null;
  #signalCode: NodeJS.Signals | null = null;
  #killedWith: NodeJS.Signals | undefined;
  #exited = false;

  constructor(exec: SpriteCommandLike, signal?: AbortSignal) {
    super();
    this.#exec = exec;
    this.stdin = exec.stdin;
    this.stdout = exec.stdout;
    this.stderr = exec.stderr;
    exec.on('exit', code => this.#exit(code));
    exec.on('error', error => {
      // An EventEmitter with no `error` listener throws; nobody listening means nobody to tell.
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    if (signal) {
      if (signal.aborted) this.kill('SIGKILL');
      else signal.addEventListener('abort', () => this.kill('SIGKILL'), { once: true });
    }
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode;
  }

  get killed(): boolean {
    return this.#killedWith !== undefined;
  }

  /** Whether the process has exited (or its connection dropped). */
  get exited(): boolean {
    return this.#exited;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.#exited) return false;
    this.#killedWith = signal;
    this.#exec.kill(signal);
    if (signal === 'SIGKILL') this.#exec.close();
    return true;
  }

  #exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    // A killed process reports its signal, as a child process does; a Sprite reports a status
    // (128 + signal, or -1 when the connection dropped first).
    if (this.#killedWith && (code < 0 || code >= 128)) {
      this.#signalCode = this.#killedWith;
    } else {
      this.#exitCode = code < 0 ? 1 : code;
    }
    this.emit('exit', this.#exitCode, this.#signalCode);
  }
}
