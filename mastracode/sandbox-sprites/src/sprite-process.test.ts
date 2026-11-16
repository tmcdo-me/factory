import { describe, expect, it } from 'vitest';

import { envOverStdin, redactSpriteError } from './sprite-exec';
import { spawnInSprite } from './sprite-process';
import type { SpriteStdioProcess } from './sprite-process';
import { ENV_PREAMBLE_INCOMPLETE, stdinEnv } from './stdin-env';
import { execUrl, fakeSpriteExec } from './test-utils';

/** Node, printing its environment's named values as JSON and then echoing stdin back. */
const ECHO = [
  '-e',
  `const names = process.argv.slice(1);
   process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n => [n, process.env[n] ?? null]))) + '\\n');
   process.stdin.on('data', d => process.stdout.write(d));
   process.stdin.on('end', () => process.exit(3));`,
];

const SECRET = 'ghs_secret-token-value';

function output(process: SpriteStdioProcess): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => (text += chunk));
    process.stdout.on('end', () => resolve(text));
  });
}

function exited(process: SpriteStdioProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise(resolve => process.once('exit', (code, signal) => resolve([code, signal])));
}

/** A raw fake Sprite, and the same Sprite as Factory uses it (every exec's env over stdin). */
function sprites(options: Parameters<typeof fakeSpriteExec>[0] = {}) {
  const raw = fakeSpriteExec(options);
  const sprite = envOverStdin({ spawn: raw.spawn, exec: () => {}, name: 'factory-row-1' });
  return { raw, sprite };
}

describe('stdinEnv', () => {
  it('writes names into the script and values, base64-encoded, only into the preamble', () => {
    const { script, preamble } = stdinEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret', GH_TOKEN: SECRET });
    expect(script).toContain('read -r __factory_env_value');
    expect(script).toContain('export GH_TOKEN');
    expect(script).not.toContain('sk-ant-oat-secret');
    expect(script.endsWith('exec "$0" "$@"')).toBe(true);
    expect(preamble).toBe(
      `${Buffer.from('sk-ant-oat-secret').toString('base64')}\n${Buffer.from(SECRET).toString('base64')}\n`,
    );
    expect(preamble).not.toContain(SECRET);
  });

  it("refuses a name sh can't export", () => {
    expect(() => stdinEnv({ 'BAD-NAME': 'x' })).toThrow(/BAD-NAME/);
    expect(() => stdinEnv({ '$(rm -rf ~)': 'x' })).toThrow(/can't be exported/);
    expect(() => stdinEnv({ __factory_env_value: 'x' })).toThrow(/can't be exported/);
  });
});

describe('envOverStdin (over a fake Sprite exec that speaks stdio)', () => {
  it('gives the process its environment over stdin, never in the exec request', async () => {
    const { raw, sprite } = sprites();
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
      GH_TOKEN: SECRET,
      PEM: '-----BEGIN KEY-----\nline two\n',
      ODD: `quotes " ' and $HOME and \\ and ünïcode`,
      EMPTY: '',
    };
    const process = spawnInSprite(sprite.spawn, 'node', [...ECHO, ...Object.keys(env)], { cwd: '/', env });
    const text = output(process);
    process.stdin.end();

    expect(JSON.parse((await text).split('\n')[0]!)).toEqual(env);
    const [request] = raw.requests;
    expect(request).toMatchObject({ command: 'sh', options: { cwd: '/' } });
    expect(request!.options).not.toHaveProperty('env');
    for (const value of ['sk-ant-oat-secret', SECRET, 'line two']) {
      expect(JSON.stringify(request)).not.toContain(value);
      expect(execUrl(request!)).not.toContain(encodeURIComponent(value));
    }
  });

  it('holds what the caller writes until the exec is connected, then passes stdin through untouched', async () => {
    const { sprite } = sprites({ connectDelayMs: 50 });
    const process = spawnInSprite(sprite.spawn, 'node', ECHO, { cwd: '/', env: { A: 'one' } });
    const errors: Error[] = [];
    process.on('error', error => errors.push(error));
    const text = output(process);
    const exit = exited(process);
    // The SDK writes its initialize request as soon as it has the process.
    process.stdin.write('{"type":"control_request","request_id":"1"}\n');
    process.stdin.write('second line with "quotes" and $HOME\n');
    process.stdin.end();

    expect((await text).split('\n').slice(1)).toEqual([
      '{"type":"control_request","request_id":"1"}',
      'second line with "quotes" and $HOME',
      '',
    ]);
    expect(await exit).toEqual([3, null]);
    expect(errors).toEqual([]);
  });

  it('exits with the preamble status when stdin ends before the environment arrived', async () => {
    const { raw } = sprites();
    const { script } = stdinEnv({ A: 'one' });
    const exec = raw.spawn('sh', ['-c', script, 'node', '-e', 'process.exit(0)'], {});
    exec.on('spawn', () => exec.stdin.end());
    expect(await exec.wait()).toBe(ENV_PREAMBLE_INCOMPLETE);
  });

  it('reports a failed connection without the exec URL, so no value or argument reaches the message', async () => {
    const { sprite } = sprites({ failConnect: 'Unexpected server response: 401' });
    const process = spawnInSprite(sprite.spawn, 'node', ['--settings', '{"internal":"/home/sprite/x"}'], {
      cwd: '/',
      env: { GH_TOKEN: SECRET },
    });
    const errors: Error[] = [];
    process.on('error', error => errors.push(error));
    expect(await exited(process)).toEqual([1, null]);
    expect(errors.map(error => error.message)).toEqual(['WebSocket error: Unexpected server response: 401']);
    for (const error of errors) {
      expect(`${error.message}\n${error.stack}`).not.toMatch(/ghs_|wss:|settings|home\/sprite/);
    }
  });

  it('refuses the exec calls that would put the environment in a URL', () => {
    const { sprite } = sprites();
    expect(() => (sprite.exec as () => void)()).toThrow(/not used by Factory/);
  });
});

describe('redactSpriteError', () => {
  it('drops the exec URL the SDK writes into its errors, and any other exec URL', () => {
    const url = `wss://api.sprites.dev/v1/sprites/x/exec?cmd=sh&env=GH_TOKEN%3D${SECRET}`;
    expect(
      redactSpriteError(new Error(`WebSocket closed before open: code=1006 reason=none (url: ${url})`)).message,
    ).toBe('WebSocket closed before open: code=1006 reason=none');
    expect(redactSpriteError(`failed at ${url}`).message).toBe('failed at <sprites exec>');
    const typed = new TypeError(`bad (url: ${url})`);
    expect(redactSpriteError(typed)).toMatchObject({ name: 'TypeError', message: 'bad' });
    expect(redactSpriteError(typed).stack).not.toContain(SECRET);
  });
});

describe('spawnInSprite', () => {
  it('kills the remote process with the signal asked for, and reports it as a child process does', async () => {
    const { raw, sprite } = sprites();
    const process = spawnInSprite(sprite.spawn, 'node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: '/', env: {} });
    await new Promise(resolve => setTimeout(resolve, 200));
    const exit = exited(process);
    expect(process.kill('SIGTERM')).toBe(true);
    expect(await exit).toEqual([null, 'SIGTERM']);
    expect(process).toMatchObject({ killed: true, exitCode: null, signalCode: 'SIGTERM', exited: true });
    expect(raw.signals).toEqual(['SIGTERM']);
    expect(process.kill('SIGKILL')).toBe(false); // already gone
  });

  it('kills and drops the connection when the caller aborts', async () => {
    const { raw, sprite } = sprites();
    const abort = new AbortController();
    const process = spawnInSprite(sprite.spawn, 'node', ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: '/',
      env: {},
      signal: abort.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    const exit = exited(process);
    abort.abort();
    expect(await exit).toEqual([null, 'SIGKILL']);
    expect(raw.signals).toEqual(['SIGKILL']);
  });
});
