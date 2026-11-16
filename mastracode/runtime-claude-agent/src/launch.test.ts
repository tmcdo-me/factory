import { describe, expect, it, vi } from 'vitest';

import { claudeProcessEnv } from './env';
import { sandboxClaudeCodeLaunch } from './launch';
import { writeSkillsPlugin } from './skills';

const installed = {
  home: '/home/sprite/.factory/claude-agent',
  executable: '/home/sprite/.factory/claude-agent/.local/bin/claude',
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
      LANG: 'en_US.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
      GH_TOKEN: 'ghs_sandbox',
      HOME: installed.home,
      CLAUDE_CONFIG_DIR: `${installed.home}/.claude`,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'factory',
    });
  });

  it('still passes the host basics when Claude Code runs on this host', () => {
    expect(claudeProcessEnv(host, {})).toMatchObject({ HOME: '/Users/tim', PATH: '/opt/homebrew/bin:/usr/bin' });
    expect(claudeProcessEnv(host, {})).not.toHaveProperty('DISABLE_AUTOUPDATER');
  });
});

describe('sandboxClaudeCodeLaunch', () => {
  it("starts the sandbox's installed binary through the sandbox, with the SDK's command line", () => {
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
      installed.executable,
      ['--output-format', 'stream-json', '--resume', 'claude-1'],
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
