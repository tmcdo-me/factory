import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { SpriteCommandLike, SpriteSpawn } from './sprite-exec';

/** One exec request as the Sprites API would receive it: what goes into the exec URL. */
export interface ExecRequest {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/** The exec URL the real SDK would build for a request (`cmd=…&env=K=V&dir=…`). */
export function execUrl(request: ExecRequest): string {
  const url = new URL('wss://api.sprites.dev/v1/sprites/factory-row-1/exec');
  for (const arg of [request.command, ...request.args]) url.searchParams.append('cmd', arg);
  for (const [key, value] of Object.entries((request.options.env as Record<string, string>) ?? {})) {
    url.searchParams.append('env', `${key}=${value}`);
  }
  if (typeof request.options.cwd === 'string') url.searchParams.set('dir', request.options.cwd);
  return url.toString();
}

/**
 * A fake raw Sprite exec (`sprite.spawn` of `@fly/sprites`) that speaks stdio for real: each exec
 * runs as a local child process with only PATH in its environment (a Sprite has its own), and
 * behaves as a WebSocket exec does: stdin written before `spawn` is lost, `exit` reports a status,
 * a signal reaches the process, and `close` drops the connection (the process is reaped). Like the
 * real SDK, a failed connection's error carries the whole exec URL, `env` values included.
 */
export function fakeSpriteExec(options: { connectDelayMs?: number; failConnect?: string; path?: string } = {}) {
  const requests: ExecRequest[] = [];
  const signals: string[] = [];
  const spawnInSprite: SpriteSpawn = (command, args = [], spawnOptions = {}) => {
    const request = { command, args, options: { ...spawnOptions } };
    requests.push(request);
    const exec = new EventEmitter() as EventEmitter & SpriteCommandLike;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let connected = false;
    let done = false;
    let child: ReturnType<typeof spawn> | undefined;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => (resolveExit = resolve));
    // Like the SDK: stdin before the connection opens is an error, and is dropped.
    stdin.on('data', chunk => {
      if (connected) child?.stdin?.write(chunk);
      else exec.emit('error', new Error(`WebSocket not open (dropped ${chunk.length} bytes)`));
    });
    stdin.on('end', () => child?.stdin?.end());
    const finish = (code: number) => {
      if (done) return;
      done = true;
      stdout.end();
      stderr.end();
      resolveExit(code);
      exec.emit('exit', code);
    };
    Object.assign(exec, {
      stdin,
      stdout,
      stderr,
      wait: () => exited,
      kill: (signal = 'SIGTERM') => {
        signals.push(signal);
        child?.kill(signal as NodeJS.Signals);
      },
      close: () => {
        child?.kill('SIGKILL');
        finish(-1);
      },
    });
    setTimeout(() => {
      if (options.failConnect) {
        exec.emit('error', new Error(`WebSocket error: ${options.failConnect} (url: ${execUrl(request)})`));
        finish(-1);
        return;
      }
      child = spawn(command, args, {
        ...(typeof spawnOptions.cwd === 'string' ? { cwd: spawnOptions.cwd } : {}),
        env: { PATH: options.path ?? process.env.PATH ?? '/usr/bin:/bin', ...spawnOptions.env },
        stdio: 'pipe',
      });
      child.stdout!.on('data', chunk => stdout.write(chunk));
      child.stderr!.on('data', chunk => stderr.write(chunk));
      child.on('exit', (code, signal) => finish(code ?? (signal ? 128 + signalNumber(signal) : 1)));
      connected = true;
      exec.emit('spawn');
    }, options.connectDelayMs ?? 20);
    return exec;
  };
  return { spawn: spawnInSprite, requests, signals };
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1;
}
