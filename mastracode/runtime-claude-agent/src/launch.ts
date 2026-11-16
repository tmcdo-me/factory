import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxProcesses } from '@factory/agent-runtime';

import { CLAUDE_CODE_MANAGED_DIR, SHA256_SHELL, managedSettingsCheck } from './install';
import type { InstalledClaudeCode } from './install';
import type { SkillFiles } from './skills';

/**
 * Where and how a session's Claude Code runs, when that is not simply this host: the pieces of
 * `ClaudeAgentSessionOptions` (and `claudeProcessEnv`) that follow from the place.
 */
export interface ClaudeCodeLaunch {
  /** Claude Code's own HOME where it runs; `<home>/.claude` keeps its config and transcripts. */
  home: string;
  /** It runs on another machine: none of this host's environment applies (`claudeProcessEnv`). */
  remote: boolean;
  /** The filesystem it runs on, for the session's skills plugin. */
  files: SkillFiles;
  spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess'];
  pathToClaudeCodeExecutable?: string;
}

/** Exit status of a launch refused because the binary no longer matches its checksum. */
export const LAUNCH_BINARY_MISMATCH = 98;
/** Exit status of a launch refused because managed settings appeared in the sandbox. */
export const LAUNCH_MANAGED_SETTINGS = 99;

/**
 * The `sh -c` script every launch runs in the sandbox, ahead of Claude Code itself: the binary must
 * still have the checksum the install verified (a repository's setup or tests could have replaced
 * it), and no managed settings may have appeared. Only then does it `exec` the binary, with the
 * SDK's arguments, in the same process, so stdio and signals are Claude Code's own.
 */
export function claudeCodeLaunchScript(
  installed: Pick<InstalledClaudeCode, 'executable' | 'checksum'>,
  options: { managedDir?: string } = {},
): string {
  if (!/^\/[A-Za-z0-9._/+@-]+$/.test(installed.executable)) {
    throw new Error(`Not a plain path: ${JSON.stringify(installed.executable)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(installed.checksum)) throw new Error('Not a SHA-256 digest');
  return [
    `bin='${installed.executable}'`,
    SHA256_SHELL,
    `[ -f "$bin" ] && [ "$(sha256 "$bin")" = '${installed.checksum}' ] || { echo "factory: the Claude Agent binary in this sandbox no longer matches its release checksum; refusing to start it" >&2; exit ${LAUNCH_BINARY_MISMATCH}; }`,
    managedSettingsCheck(options.managedDir ?? CLAUDE_CODE_MANAGED_DIR, LAUNCH_MANAGED_SETTINGS),
    'unset CLAUDE_CODE_MANAGED_SETTINGS_PATH',
    'exec "$bin" "$@"',
  ].join('\n');
}

/**
 * Claude Code inside a sandbox: the SDK starts the sandbox's verified binary through the sandbox's
 * `spawn` (behind {@link claudeCodeLaunchScript}) and talks to it over stdio exactly as to a local
 * process. Its MCP traffic (Factory's in-process `factory` server) and control requests travel on
 * that same stdio, so they need no network path back to Factory.
 */
export function sandboxClaudeCodeLaunch(
  processes: Pick<SandboxProcesses, 'spawn' | 'files'>,
  installed: Pick<InstalledClaudeCode, 'home' | 'executable' | 'checksum'>,
  options: { managedDir?: string } = {},
): ClaudeCodeLaunch {
  const script = claudeCodeLaunchScript(installed, options);
  return {
    home: installed.home,
    remote: true,
    files: processes.files,
    // The SDK only hands this path back to `spawnClaudeCodeProcess`; it exists inside the sandbox.
    pathToClaudeCodeExecutable: installed.executable,
    spawnClaudeCodeProcess: ({ args, cwd, env, signal }) =>
      processes.spawn('sh', ['-c', script, 'claude', ...args], {
        cwd: cwd ?? installed.home,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
        signal,
      }),
  };
}
