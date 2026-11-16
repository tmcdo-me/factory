import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SandboxProcess, SandboxProcesses } from '@factory/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_CODE_INSTALLER_URL,
  bundledClaudeCodeChecksums,
  bundledClaudeCodeVersion,
  claudeCodeInstallScript,
  ensureClaudeCode,
  runInProcesses,
  SYSTEM_PATH,
} from './install';
import type { RunInSandbox } from './install';

const sdkDir = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
const sdkManifest = JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8')) as {
  version: string;
  platforms: Record<string, { checksum: string }>;
};

describe('the pinned release', () => {
  it("is the CLI version the installed SDK bundles, read from the SDK's own package", () => {
    const sdk = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as { claudeCodeVersion: string };
    expect(bundledClaudeCodeVersion()).toBe(sdk.claudeCodeVersion);
    expect(sdkManifest.version).toBe(bundledClaudeCodeVersion());
  });

  it("checks against the SDK manifest's checksums for that version's Linux builds", () => {
    const linux = Object.entries(sdkManifest.platforms)
      .filter(([platform]) => platform.startsWith('linux-'))
      .map(([, entry]) => entry.checksum);
    expect(linux.length).toBeGreaterThanOrEqual(2);
    expect(bundledClaudeCodeChecksums()).toEqual(linux);
  });
});

describe('claudeCodeInstallScript', () => {
  const sum = 'a'.repeat(64);

  it('runs the official installer for exactly the pinned version, from its own home, with auto-update off', () => {
    const script = claudeCodeInstallScript('2.1.325', [sum]);
    expect(script).toContain(
      `curl -fsSL ${CLAUDE_CODE_INSTALLER_URL} | HOME="$home" DISABLE_AUTOUPDATER=1 bash -s "$want"`,
    );
    expect(script).toContain("want='2.1.325'");
    expect(script.indexOf('cd "$home"')).toBeLessThan(script.indexOf('curl'));
    expect(CLAUDE_CODE_INSTALLER_URL).toBe('https://claude.ai/install.sh');
  });

  it('refuses anything but a version and digests, so nothing else reaches the shell', () => {
    expect(() => claudeCodeInstallScript("2.1.325'; rm -rf ~; '", [sum])).toThrow(/Not a Claude Code version/);
    expect(() => claudeCodeInstallScript('latest', [sum])).toThrow(/Not a Claude Code version/);
    expect(() => claudeCodeInstallScript('2.1.325', ["'; rm -rf ~"])).toThrow(/SHA-256/);
    expect(() => claudeCodeInstallScript('2.1.325', [])).toThrow(/SHA-256/);
  });
});

/**
 * The install script, run by a real `sh` in a fake sandbox: a home directory, and a fake `curl`
 * serving an "installer" that installs a fixed binary as the real one does (a versioned file and a
 * `~/.local/bin/claude` link to it). Each binary records it when it runs.
 */
describe('ensureClaudeCode (in a fake sandbox)', () => {
  let root: string;
  let calls: string;
  let ran: string;
  let managedDir: string;
  let official: string;
  const binary = (name: string) => `#!/bin/sh\necho "${name}" >> '${ran}'\n`;
  const sha = (content: string) => createHash('sha256').update(content).digest('hex');

  beforeEach(async () => {
    root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'claude-install-'));
    calls = join(root, 'installer-calls');
    ran = join(root, 'binary-ran');
    managedDir = join(root, 'etc-claude-code');
    official = binary('official');
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'home'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fake `curl` serving an installer that installs `content` as the binary. */
  async function fakeInstaller(content = official) {
    await writeFile(join(root, 'release'), content);
    const installer = [
      '#!/bin/sh',
      `echo "$HOME $1 $(pwd)" >> '${calls}'`,
      'mkdir -p "$HOME/.local/bin" "$HOME/.local/share/claude/versions"',
      `cp '${join(root, 'release')}' "$HOME/.local/share/claude/versions/$1"`,
      'chmod 755 "$HOME/.local/share/claude/versions/$1"',
      'ln -sf "$HOME/.local/share/claude/versions/$1" "$HOME/.local/bin/claude"',
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
        // The user's PATH also holds what a repository planted (`planted/`), ahead of everything.
        {
          cwd: '/',
          env: {
            HOME: join(root, 'home'),
            PATH: `${join(root, 'planted')}:${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
          },
        },
        (error, stdout, stderr) =>
          resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
  // The fake `curl` sits ahead of the system's tools, standing in for the real one there.
  const ensure = (checksums = [sha(official)]) =>
    ensureClaudeCode(run, {
      version: '2.1.325',
      checksums,
      managedDir,
      systemPath: `${join(root, 'bin')}:${SYSTEM_PATH}`,
    });
  const installerRuns = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);

  it('installs the pinned version once, from its own home, and finds it verified after that', async () => {
    await fakeInstaller();
    const home = join(root, 'home', '.factory', 'claude-agent');
    const installed = await ensure();
    expect(installed).toEqual({
      version: '2.1.325',
      home,
      executable: join(home, '.local', 'share', 'claude', 'versions', '2.1.325'),
      checksum: sha(official),
    });
    expect(installerRuns()).toEqual([`${home} 2.1.325 ${home}`]); // that home, that version, run from it

    // A later open (or a Factory restart) finds it verified: no second install.
    expect(await ensure()).toEqual(installed);
    expect(installerRuns()).toHaveLength(1);
    // A binary is never run to check it.
    expect(existsSync(ran)).toBe(false);
  });

  it('replaces a binary planted in its place, without ever running the planted one', async () => {
    await fakeInstaller();
    const installed = await ensure();
    // A repository's setup plants a wrapper (one that would print the right version).
    const planted = join(root, 'planted');
    await writeFile(planted, binary('planted'));
    await chmod(planted, 0o755);
    const link = join(installed.home, '.local', 'bin', 'claude');
    await rm(link);
    await symlink(planted, link);

    expect(await ensure()).toEqual(installed);
    expect(installerRuns()).toHaveLength(2);
    expect(existsSync(ran)).toBe(false);
  });

  it("checks with the system's own tools, not ones a repository planted on the user's PATH", async () => {
    await fakeInstaller(binary('tampered'));
    // A planted `sha256sum` (and `shasum`) that vouches for anything.
    await mkdir(join(root, 'planted'));
    for (const tool of ['sha256sum', 'shasum']) {
      await writeFile(join(root, 'planted', tool), `#!/bin/sh\necho "${sha(official)}  $1"\n`);
      await chmod(join(root, 'planted', tool), 0o755);
    }
    await expect(ensure()).rejects.toThrow(/does not match its published checksum/);
  });

  it('fails, saying so, when the installer leaves a binary that is not the release', async () => {
    await fakeInstaller(binary('tampered'));
    await expect(ensure()).rejects.toThrow(
      /Claude Agent could not be installed.*2\.1\.325.*does not match its published checksum/s,
    );
  });

  it('refuses a sandbox that holds managed settings Factory did not write', async () => {
    await fakeInstaller();
    await mkdir(managedDir);
    await writeFile(join(managedDir, 'managed-settings.json'), '{"permissions":{}}');
    await expect(ensure()).rejects.toThrow(/managed settings Factory did not write/);
    expect(installerRuns()).toHaveLength(0);
  });

  it('fails when the sandbox answers without saying where it installed', async () => {
    await expect(ensureClaudeCode(async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }))).rejects.toThrow(
      /could not be installed/,
    );
  });
});

describe('runInProcesses', () => {
  /** This host's processes, as a sandbox's. */
  const local = () => {
    const spawnLocal = vi.fn(
      (command: string, args: string[], options: { cwd: string; env: Record<string, string>; signal?: AbortSignal }) =>
        spawn(command, args, {
          cwd: options.cwd,
          env: { PATH: '/usr/bin:/bin', ...options.env },
          stdio: 'pipe',
          ...(options.signal ? { signal: options.signal } : {}),
        }) as unknown as SandboxProcess,
    );
    return { spawn: spawnLocal } satisfies Pick<SandboxProcesses, 'spawn'>;
  };

  it('runs the script through the sandbox with no environment, and collects its output', async () => {
    const processes = local();
    const result = await runInProcesses(processes)('echo out; echo err >&2; exit 3');
    expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
    expect(processes.spawn).toHaveBeenCalledWith('sh', ['-c', 'echo out; echo err >&2; exit 3'], {
      cwd: '/',
      env: {},
      signal: expect.any(AbortSignal),
    });
  });

  it('gives up on a script that runs too long', async () => {
    const started = Date.now();
    // `sleep` runs as a child of `sh`, and keeps stdout open after `sh` is killed.
    const result = await runInProcesses(local(), { timeoutMs: 100 })('sleep 5; echo never');
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
