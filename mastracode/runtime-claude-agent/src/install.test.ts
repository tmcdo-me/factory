import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_INSTALLER_URL,
  bundledClaudeCodeVersion,
  claudeCodeInstallScript,
  ensureClaudeCode,
} from './install';
import type { RunInSandbox } from './install';

const sdkDir = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));

describe('bundledClaudeCodeVersion', () => {
  it("is the CLI version the installed SDK bundles, read from the SDK's own package", () => {
    const sdk = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
      version: string;
      claudeCodeVersion: string;
    };
    expect(bundledClaudeCodeVersion()).toBe(sdk.claudeCodeVersion);
    // The SDK's binary manifest names the same CLI version.
    expect(JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8')).version).toBe(bundledClaudeCodeVersion());
    expect(bundledClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('claudeCodeInstallScript', () => {
  it('runs the official installer for exactly the pinned version, with auto-update off', () => {
    const script = claudeCodeInstallScript('2.1.325');
    expect(script).toContain(
      `curl -fsSL ${CLAUDE_CODE_INSTALLER_URL} | HOME="$home" DISABLE_AUTOUPDATER=1 bash -s "$want"`,
    );
    expect(script).toContain("want='2.1.325'");
    expect(CLAUDE_CODE_INSTALLER_URL).toBe('https://claude.ai/install.sh');
  });

  it('refuses anything but a version, so nothing else reaches the shell', () => {
    expect(() => claudeCodeInstallScript("2.1.325'; rm -rf ~; '")).toThrow(/Not a Claude Code version/);
    expect(() => claudeCodeInstallScript('latest')).toThrow(/Not a Claude Code version/);
  });
});

/**
 * The install script, run by a real `sh` in a fake sandbox: a home directory, and a fake `curl`
 * whose "installer" writes a `claude` that reports the version it was asked for (or a wrong one).
 */
describe('ensureClaudeCode (in a fake sandbox)', () => {
  let root: string;
  let calls: string;
  beforeEach(async () => {
    root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'claude-install-'));
    calls = join(root, 'installer-calls');
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'home'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fake `curl` serving an installer that installs `reported` (default: the version asked for). */
  async function fakeInstaller(reported?: string) {
    const installer = [
      '#!/bin/sh',
      `echo "$HOME $1" >> '${calls}'`,
      'mkdir -p "$HOME/.local/bin"',
      `version="${reported ?? '$1'}"`,
      `printf '#!/bin/sh\\necho "%s (Claude Code)"\\n' "$version" > "$HOME/.local/bin/claude"`,
      'chmod +x "$HOME/.local/bin/claude"',
    ].join('\n');
    await writeFile(join(root, 'installer.sh'), installer);
    await writeFile(join(root, 'bin', 'curl'), `#!/bin/sh\ncat '${join(root, 'installer.sh')}'\n`);
    await chmod(join(root, 'bin', 'curl'), 0o755);
  }

  const run: RunInSandbox = script =>
    new Promise(resolve => {
      execFile(
        'sh',
        ['-c', script],
        { env: { HOME: join(root, 'home'), PATH: `${join(root, 'bin')}:/usr/bin:/bin` } },
        (error, stdout, stderr) =>
          resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  it('installs the pinned version once, into a home of its own, and finds it again after that', async () => {
    await fakeInstaller();
    const home = join(root, 'home', '.factory', 'claude-agent');
    const installed = await ensureClaudeCode(run, { version: '2.1.325' });
    expect(installed).toEqual({ version: '2.1.325', home, executable: join(home, '.local', 'bin', 'claude') });
    expect(readFileSync(calls, 'utf8')).toBe(`${home} 2.1.325\n`); // the installer ran with that home and version

    // A later start (or a Factory restart) finds it installed: no second install.
    expect(await ensureClaudeCode(run, { version: '2.1.325' })).toEqual(installed);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('reinstalls when the sandbox has another version, as after an SDK upgrade', async () => {
    await fakeInstaller();
    await ensureClaudeCode(run, { version: '2.1.300' });
    await ensureClaudeCode(run, { version: '2.1.325' });
    expect(
      readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map(line => line.split(' ')[1]),
    ).toEqual(['2.1.300', '2.1.325']);
  });

  it('defaults to the version the SDK bundles', async () => {
    await fakeInstaller();
    expect((await ensureClaudeCode(run)).version).toBe(bundledClaudeCodeVersion());
  });

  it('fails, saying so, when the installer leaves another version behind', async () => {
    await fakeInstaller('9.9.9');
    await expect(ensureClaudeCode(run, { version: '2.1.325' })).rejects.toThrow(
      /Claude Agent could not be installed.*2\.1\.325.*installed version is 9\.9\.9 \(Claude Code\), wanted 2\.1\.325/s,
    );
  });

  it('fails when the sandbox answers without saying where it installed', async () => {
    await expect(ensureClaudeCode(async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }))).rejects.toThrow(
      /could not be installed/,
    );
  });
});
