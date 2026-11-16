import { describe, expect, it } from 'vitest';

import { spawnInSprite } from './sprite-process';
import type { SpriteStdioProcess } from './sprite-process';
import { ENV_PREAMBLE_INCOMPLETE, stdinEnv } from './stdin-env';
import { fakeSpriteExec } from './test-utils';

/** Node, printing its environment's named values and then echoing stdin back, line by line. */
const ECHO = [
  '-e',
  `const names = process.argv.slice(1);
   process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n => [n, process.env[n] ?? null]))) + '\\n');
   process.stdin.on('data', d => process.stdout.write(d));
   process.stdin.on('end', () => process.exit(3));`,
];

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

describe('stdinEnv', () => {
  it('writes names into the script and values only into the preamble', () => {
    const { script, preamble } = stdinEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret', GH_TOKEN: 'ghs_x' });
    expect(script).toContain('read -r CLAUDE_CODE_OAUTH_TOKEN');
    expect(script).toContain('export GH_TOKEN');
    expect(script).not.toContain('sk-ant-oat-secret');
    expect(script.endsWith('exec "$0" "$@"')).toBe(true);
    expect(preamble).toBe('sk-ant-oat-secret\nghs_x\n');
  });

  it("refuses a name sh can't export and a value with a line break, without echoing the value", () => {
    expect(() => stdinEnv({ 'BAD-NAME': 'x' })).toThrow(/BAD-NAME/);
    expect(() => stdinEnv({ '$(rm -rf ~)': 'x' })).toThrow(/can't be exported/);
    let message = '';
    try {
      stdinEnv({ TOKEN: 'line1\nline2-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TOKEN has a line break/);
    expect(message).not.toContain('secret');
  });
});

describe('spawnInSprite (over a fake Sprite exec that speaks stdio)', () => {
  it('gives the process its environment over stdin, never in the exec request', async () => {
    const sprite = fakeSpriteExec();
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret', GH_TOKEN: 'ghs_x', HOME: '/home/sprite/.claude-home' };
    const process = spawnInSprite(sprite.spawn, 'node', [...ECHO, ...Object.keys(env)], { cwd: '/', env });
    const text = output(process);
    process.stdin.end();

    expect(JSON.parse((await text).split('\n')[0]!)).toEqual(env);
    const [request] = sprite.requests;
    expect(request).toMatchObject({ command: 'sh', options: { cwd: '/' } });
    expect(request!.options).not.toHaveProperty('env');
    expect(JSON.stringify(request)).not.toContain('sk-ant-oat-secret');
    expect(JSON.stringify(request)).not.toContain('ghs_x');
  });

  it('holds what the caller writes until the exec is connected, then passes stdin through untouched', async () => {
    const sprite = fakeSpriteExec({ connectDelayMs: 50 });
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
    expect(process.exitCode).toBe(3);
    expect(errors).toEqual([]);
  });

  it('exits with the preamble status when stdin ends before the environment arrived', async () => {
    const sprite = fakeSpriteExec();
    const { script } = stdinEnv({ A: 'one' });
    // The script alone, with nothing on stdin: the read fails, and the command never starts.
    const exec = sprite.spawn('sh', ['-c', script, 'node', '-e', 'process.exit(0)'], {});
    exec.on('spawn', () => exec.stdin.end());
    const code = await new Promise<number>(resolve => exec.on('exit', resolve));
    expect(code).toBe(ENV_PREAMBLE_INCOMPLETE);
  });

  it('kills the remote process with the signal asked for, and reports it as a child process does', async () => {
    const sprite = fakeSpriteExec();
    const process = spawnInSprite(sprite.spawn, 'node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: '/', env: {} });
    await new Promise(resolve => setTimeout(resolve, 200));
    const exit = exited(process);
    expect(process.kill('SIGTERM')).toBe(true);
    expect(await exit).toEqual([null, 'SIGTERM']);
    expect(process).toMatchObject({ killed: true, exitCode: null, signalCode: 'SIGTERM' });
    expect(sprite.signals).toEqual(['SIGTERM']);
    expect(process.kill('SIGKILL')).toBe(false); // already gone
  });

  it('kills and drops the connection when the caller aborts', async () => {
    const sprite = fakeSpriteExec();
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
    expect(sprite.signals).toEqual(['SIGKILL']);
  });

  it('reports a failed connection as an error, then an exit', async () => {
    const sprite = fakeSpriteExec({ failConnect: new Error('WebSocket closed before open: code=1006') });
    const process = spawnInSprite(sprite.spawn, 'node', ECHO, { cwd: '/', env: { A: 'one' } });
    const errors: Error[] = [];
    process.on('error', error => errors.push(error));
    expect(await exited(process)).toEqual([1, null]);
    expect(errors.map(error => error.message)).toEqual(['WebSocket closed before open: code=1006']);
  });
});
