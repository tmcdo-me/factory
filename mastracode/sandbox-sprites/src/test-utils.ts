import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { SpriteCommandLike, SpriteSpawn } from './sprite-process';

/** One exec request as the Sprites API would receive it (the URL's command, args and dir). */
export interface ExecRequest {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/**
 * A fake Sprite exec that speaks stdio for real: each exec runs as a local child process, with an
 * empty environment beyond PATH (a Sprite has its own), and behaves as a WebSocket exec does: stdin
 * written before `spawn` is lost (`connectDelayMs` is the connect time), `exit` reports a status,
 * a signal reaches the process, and `close` drops the connection (the process is reaped).
 */
export function fakeSpriteExec(options: { connectDelayMs?: number; failConnect?: Error } = {}) {
  const requests: ExecRequest[] = [];
  const signals: string[] = [];
  const spawnInSprite: SpriteSpawn = (command, args, spawnOptions) => {
    requests.push({ command, args, options: { ...spawnOptions } });
    const exec = new EventEmitter() as EventEmitter & SpriteCommandLike;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let connected = false;
    let done = false;
    // Like the SDK: stdin before the connection opens is an error, and is dropped.
    stdin.on('data', chunk => {
      if (connected) child?.stdin?.write(chunk);
      else exec.emit('error', new Error(`WebSocket not open (dropped ${chunk.length} bytes)`));
    });
    stdin.on('end', () => child?.stdin?.end());
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      stdout.end();
      stderr.end();
      exec.emit('exit', code);
    };
    Object.assign(exec, {
      stdin,
      stdout,
      stderr,
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
        exec.emit('error', options.failConnect);
        finish(-1);
        return;
      }
      child = spawn(command, args, {
        cwd: spawnOptions.cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
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
