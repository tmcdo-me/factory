import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxProcesses } from '@factory/agent-runtime';

import { BASH_SANDBOX_WRITABLE_HOME_DIRS } from './bash-sandbox';
import { CLAUDE_CODE_MANAGED_DIR, SHA256_SHELL, SYSTEM_PATH, managedSettingsCheck } from './install';
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
/** Exit status of a launch refused because Claude Code's Bash sandbox can't run in the sandbox. */
export const LAUNCH_BASH_SANDBOX_UNAVAILABLE = 97;

/**
 * Shell: `$drop` runs a command without the Linux capabilities this process may hold. A Sprite's
 * user holds a container's default set as ambient capabilities, which every child inherits, and
 * bubblewrap refuses to run with capabilities it didn't get from being setuid. Claude Code needs
 * none (privileged work goes through `sudo`), so it runs without them too; and a sandboxed command
 * then holds no more than Claude Code does.
 */
const DROP_CAPABILITIES_SHELL = [
  'drop=',
  "if command -v setpriv >/dev/null 2>&1 && [ -n \"$(awk '/^Cap(Inh|Amb):/ { print $2 }' /proc/self/status 2>/dev/null | tr -d '0\\n')\" ]; then",
  '  drop="$(command -v setpriv) --inh-caps=-all --ambient-caps=-all"',
  'fi',
].join('\n');

/**
 * Shell, Linux: make the sandbox ready for Claude Code's Bash sandbox, or refuse to start. Each
 * sandboxed command gets its own PID namespace and a fresh `/proc` (so Claude Code's process, and
 * the credential in its environment, are out of its sight). The kernel refuses that mount in a user
 * namespace while the container's `/proc` has files masked over (a Sprite's container masks
 * `/proc/kcore`, `/proc/keys`…); a Sprite is a VM of its own, so those masks guard nothing the
 * session doesn't own, and they come off (with `sudo`, again after a restart). Then the writable
 * cache directories are created (a sandbox rule for a missing path has no effect), and a trial
 * sandbox must start.
 */
function bashSandboxReadyShell(): string {
  const dirs = BASH_SANDBOX_WRITABLE_HOME_DIRS.map(dir => `"$HOME/${dir}"`).join(' ');
  return [
    // Only masks: a tmpfs file or empty directory mounted over part of /proc.
    'for m in $(awk \'{ split($0, p, " - "); split(p[2], f, " ") } $5 ~ "^/proc/" && (f[1] == "tmpfs" || f[1] == "devtmpfs") { print $5 }\' /proc/self/mountinfo 2>/dev/null | sort -r); do sudo -n umount "$m" 2>/dev/null || true; done',
    `mkdir -p ${dirs} 2>/dev/null || true`,
    `if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1 || ! $drop bwrap --ro-bind / / --unshare-pid --unshare-net --dev /dev --proc /proc true >/dev/null 2>&1; then echo "factory: Claude Code's Bash sandbox can't run in this sandbox (it needs bubblewrap and socat, and a /proc it may mount); refusing to start Claude Code without it" >&2; exit ${LAUNCH_BASH_SANDBOX_UNAVAILABLE}; fi`,
  ].join('\n');
}

/**
 * The `sh -c` script every launch runs in the sandbox, ahead of Claude Code itself: the binary must
 * still have the checksum the install verified (a repository's setup or tests could have replaced
 * it), and no managed settings may have appeared; with `bashSandbox`, Claude Code's Bash sandbox
 * must be able to run. Only then does it `exec` the binary (without capabilities), with the SDK's
 * arguments, in the same process, so stdio and signals are Claude Code's own.
 */
export function claudeCodeLaunchScript(
  installed: Pick<InstalledClaudeCode, 'executable' | 'checksum'>,
  options: { managedDir?: string; bashSandbox?: boolean; systemPath?: string } = {},
): string {
  const systemPath = options.systemPath ?? SYSTEM_PATH;
  if (!/^\/[A-Za-z0-9._/:-]+$/.test(systemPath)) throw new Error(`Not a plain PATH: ${systemPath}`);
  if (!/^\/[A-Za-z0-9._/+@-]+$/.test(installed.executable)) {
    throw new Error(`Not a plain path: ${JSON.stringify(installed.executable)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(installed.checksum)) throw new Error('Not a SHA-256 digest');
  return [
    `bin='${installed.executable}'`,
    // The checks use the system's own tools; Claude Code then gets the PATH the exec had.
    '__factory_path=${PATH:-/usr/local/bin:/usr/bin:/bin}',
    `PATH='${systemPath}'`,
    SHA256_SHELL,
    `[ -f "$bin" ] && [ "$(sha256 "$bin")" = '${installed.checksum}' ] || { echo "factory: the Claude Agent binary in this sandbox no longer matches its release checksum; refusing to start it" >&2; exit ${LAUNCH_BINARY_MISMATCH}; }`,
    managedSettingsCheck(options.managedDir ?? CLAUDE_CODE_MANAGED_DIR, LAUNCH_MANAGED_SETTINGS),
    'unset CLAUDE_CODE_MANAGED_SETTINGS_PATH',
    DROP_CAPABILITIES_SHELL,
    ...(options.bashSandbox ? [bashSandboxReadyShell()] : []),
    'PATH=$__factory_path',
    'export PATH',
    'unset __factory_path',
    'exec $drop "$bin" "$@"',
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
  options: { managedDir?: string; bashSandbox?: boolean; systemPath?: string } = {},
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
