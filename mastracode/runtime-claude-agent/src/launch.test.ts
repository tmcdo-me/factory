import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BASH_SANDBOX_WRITABLE_HOME_DIRS } from './bash-sandbox';
import { claudeProcessEnv } from './env';
import {
  LAUNCH_BASH_SANDBOX_UNAVAILABLE,
  LAUNCH_BINARY_MISMATCH,
  LAUNCH_MANAGED_SETTINGS,
  claudeCodeLaunchScript,
  sandboxClaudeCodeLaunch,
} from './launch';
import { writeSkillsPlugin } from './skills';

const installed = {
  home: '/home/sprite/.factory/claude-agent',
  executable: '/home/sprite/.factory/claude-agent/.local/share/claude/versions/2.1.325',
  checksum: 'c'.repeat(64),
};

describe('claudeProcessEnv for Claude Code in a sandbox', () => {
  const host = {
    HOME: '/Users/tim',
    PATH: '/opt/homebrew/bin:/usr/bin',
    TMPDIR: '/Volumes/Dev/tmp/',
    SHELL: '/bin/zsh',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    HTTPS_PROXY: 'http://proxy.lan:3128',
    CLAUDE_CONFIG_DIR: '/Users/tim/.claude',
    LANG: 'en_US.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
    DATABASE_URL: 'postgres://secret',
    GITHUB_APP_PRIVATE_KEY: 'pem',
    SPRITES_TOKEN: 'fly-sprites-token',
  };

  it("passes Claude's credential and the sandbox's git credentials, and nothing of this host", () => {
    const env = claudeProcessEnv(host, { GH_TOKEN: 'ghs_sandbox' }, { home: installed.home, remote: true });
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'en_US.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
      GH_TOKEN: 'ghs_sandbox',
      HOME: installed.home,
      CLAUDE_CONFIG_DIR: `${installed.home}/.claude`,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'factory',
    });
  });

  // fork(claude-agent): live, `git ls-remote` in Claude's shell hung on Homebrew's system
  // `credential.helper=osxkeychain` once HOME was Claude's own home.
  it("keeps git in Claude's shell from prompting or using the host's system config", () => {
    expect(claudeProcessEnv(host, {})).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
    // A sandbox that needs its system config can still say so.
    expect(claudeProcessEnv(host, { GIT_CONFIG_NOSYSTEM: '0' })).toMatchObject({ GIT_CONFIG_NOSYSTEM: '0' });
  });

  it('still passes the host basics when Claude Code runs on this host', () => {
    expect(claudeProcessEnv(host, {})).toMatchObject({ HOME: '/Users/tim', PATH: '/opt/homebrew/bin:/usr/bin' });
    expect(claudeProcessEnv(host, {})).not.toHaveProperty('DISABLE_AUTOUPDATER');
  });
});

describe('sandboxClaudeCodeLaunch', () => {
  it("starts the sandbox's verified binary through the sandbox, behind the launch check", () => {
    const process = { stdin: {}, stdout: {} };
    const processes = { spawn: vi.fn(() => process as never), files: {} as never };
    const launch = sandboxClaudeCodeLaunch(processes, installed);
    expect(launch).toMatchObject({
      home: installed.home,
      remote: true,
      pathToClaudeCodeExecutable: installed.executable,
    });

    const abort = new AbortController();
    const spawned = launch.spawnClaudeCodeProcess!({
      command: installed.executable,
      args: ['--output-format', 'stream-json', '--resume', 'claude-1'],
      cwd: '/home/sprite/repo',
      env: { HOME: installed.home, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x', UNSET: undefined },
      signal: abort.signal,
    });
    expect(spawned).toBe(process);
    expect(processes.spawn).toHaveBeenCalledWith(
      'sh',
      ['-c', claudeCodeLaunchScript(installed), 'claude', '--output-format', 'stream-json', '--resume', 'claude-1'],
      {
        cwd: '/home/sprite/repo',
        env: { HOME: installed.home, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' },
        signal: abort.signal,
      },
    );
  });

  it("writes the session's skills plugin on the sandbox's filesystem", async () => {
    const written = new Map<string, string>();
    const files = {
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async (path: string, content: string | Uint8Array) => {
        written.set(path, String(content));
      }),
      isDirectory: async () => false,
    };
    const launch = sandboxClaudeCodeLaunch({ spawn: vi.fn(), files }, installed);
    const dir = `${installed.home}/factory-skills/s1`;
    const skills = await writeSkillsPlugin(
      dir,
      [{ name: 'factory-plan', description: 'Plan', instructions: 'Plan it.' }],
      launch.files,
    );

    expect(skills.plugin).toEqual({ type: 'local', path: dir, skipMcpDiscovery: true });
    expect(files.rm).toHaveBeenCalledWith(dir);
    expect([...written.keys()]).toEqual([`${dir}/.claude-plugin/plugin.json`, `${dir}/skills/factory-plan/SKILL.md`]);
    expect(written.get(`${dir}/skills/factory-plan/SKILL.md`)).toContain('Plan it.');
  });
});

/** The launch script run by a real `sh`, against a fake installed binary that prints its arguments. */
describe('claudeCodeLaunchScript', () => {
  async function fixture() {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'claude-launch-'));
    const executable = join(root, 'claude');
    const content = '#!/bin/sh\necho "args:$*|managed:${CLAUDE_CODE_MANAGED_SETTINGS_PATH:-unset}|path:$PATH"\n';
    await writeFile(executable, content);
    await chmod(executable, 0o755);
    const checksum = createHash('sha256').update(content).digest('hex');
    const managedDir = join(root, 'etc-claude-code');
    const planted = join(root, 'planted');
    const userPath = `${planted}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const launch = (script: string, env: Record<string, string> = {}) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
        execFile(
          'sh',
          ['-c', script, 'claude', '--print', 'x'],
          { env: { PATH: userPath, CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/tmp/evil.json', ...env } },
          (error, stdout, stderr) =>
            resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
        );
      });
    return { root, executable, checksum, managedDir, launch, planted, userPath };
  }

  it('runs the verified binary with the SDK arguments, with no managed-settings path', async () => {
    const { root, executable, checksum, managedDir, launch, userPath } = await fixture();
    try {
      const result = await launch(claudeCodeLaunchScript({ executable, checksum }, { managedDir }));
      expect(result).toMatchObject({ code: 0, stdout: `args:--print x|managed:unset|path:${userPath}\n` });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a binary that changed since it was verified', async () => {
    const { root, executable, checksum, managedDir, launch } = await fixture();
    try {
      await writeFile(executable, '#!/bin/sh\necho stolen\n');
      const result = await launch(claudeCodeLaunchScript({ executable, checksum }, { managedDir }));
      expect(result.code).toBe(LAUNCH_BINARY_MISMATCH);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/no longer matches its release checksum/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks with the system's own tools, not a sha256sum planted on the PATH", async () => {
    const { root, executable, checksum, managedDir, launch, planted } = await fixture();
    try {
      await writeFile(executable, '#!/bin/sh\necho stolen\n');
      await mkdir(planted);
      for (const tool of ['sha256sum', 'shasum']) {
        await writeFile(join(planted, tool), `#!/bin/sh\necho "${checksum}  $1"\n`);
        await chmod(join(planted, tool), 0o755);
      }
      const result = await launch(claudeCodeLaunchScript({ executable, checksum }, { managedDir }));
      expect(result.code).toBe(LAUNCH_BINARY_MISMATCH);
      expect(result.stdout).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to start when managed settings appeared', async () => {
    const { root, executable, checksum, managedDir, launch } = await fixture();
    try {
      await mkdir(join(managedDir, 'managed-settings.d'), { recursive: true });
      const result = await launch(claudeCodeLaunchScript({ executable, checksum }, { managedDir }));
      expect(result.code).toBe(LAUNCH_MANAGED_SETTINGS);
      expect(result.stdout).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** System tools standing in for bubblewrap, socat and sudo, first on the launch's system PATH. */
  async function sandboxTools(root: string, tools: Record<string, string>) {
    const dir = join(root, 'system-bin');
    await mkdir(dir);
    for (const [name, body] of Object.entries(tools)) {
      await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(dir, name), 0o755);
    }
    return `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
  }

  it("with Claude Code's Bash sandbox, starts once a trial sandbox runs, with the cache directories made", async () => {
    const { root, executable, checksum, managedDir, launch, userPath } = await fixture();
    try {
      const trial = join(root, 'trial');
      const systemPath = await sandboxTools(root, {
        bwrap: `echo "$*" >> '${trial}'`,
        socat: 'exit 0',
        sudo: 'exit 1',
      });
      const home = join(root, 'home');
      const script = claudeCodeLaunchScript({ executable, checksum }, { managedDir, bashSandbox: true, systemPath });
      const result = await launch(script, { HOME: home });
      expect(result).toMatchObject({ code: 0, stdout: `args:--print x|managed:unset|path:${userPath}\n` });
      // The trial: its own PID namespace and a fresh /proc, as the sandbox's commands get.
      expect(await readFile(trial, 'utf8')).toMatch(/--unshare-pid .*--proc \/proc true/);
      for (const dir of BASH_SANDBOX_WRITABLE_HOME_DIRS) expect((await stat(join(home, dir))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to start Claude Code when its Bash sandbox can't run, rather than run it unsandboxed", async () => {
    const { root, executable, checksum, managedDir, launch } = await fixture();
    try {
      // bubblewrap is there but can't build a sandbox (say, a /proc it may not mount).
      const failing = await sandboxTools(root, { bwrap: 'exit 1', socat: 'exit 0' });
      const script = claudeCodeLaunchScript(
        { executable, checksum },
        { managedDir, bashSandbox: true, systemPath: failing },
      );
      const result = await launch(script, { HOME: join(root, 'home') });
      expect(result.code).toBe(LAUNCH_BASH_SANDBOX_UNAVAILABLE);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Bash sandbox can't run in this sandbox/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes only a plain path and a digest', () => {
    expect(() => claudeCodeLaunchScript({ executable: "/x'; rm -rf ~; '", checksum: installed.checksum })).toThrow(
      /plain path/,
    );
    expect(() => claudeCodeLaunchScript({ executable: '/x', checksum: 'nope' })).toThrow(/SHA-256/);
  });
});
