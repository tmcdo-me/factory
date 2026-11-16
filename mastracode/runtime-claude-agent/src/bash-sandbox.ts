import { SYSTEM_PATH } from './install';
import type { RunInSandbox } from './install';

/** Claude's own credentials: what the Bash sandbox keeps from the commands Claude runs. */
const CLAUDE_CREDENTIAL_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Directories under Claude's home where package managers and build tools keep their caches (npm,
 * pnpm, yarn, bun, pip/uv and Go's build cache under `.cache`, Go modules, Cargo, Gradle, Maven,
 * macOS's `Library/Caches`). The Bash sandbox lets commands write only in the checkout and the
 * temp directory; these are writable too. On Linux a sandbox rule for a missing path has no
 * effect, so they must exist before Claude Code starts (the launch creates them). Claude's config
 * directory (`.claude`) and its binaries (`.local`) stay read-only to commands.
 */
export const BASH_SANDBOX_WRITABLE_HOME_DIRS = [
  '.npm',
  '.cache',
  '.local/share/pnpm',
  '.yarn',
  '.bun',
  'go',
  '.cargo',
  '.gradle',
  '.m2',
  'Library/Caches',
] as const;

export interface ClaudeAgentBashSandboxOptions {
  /**
   * Files commands must not read, beyond Claude's own saved login (the host's env file that holds
   * `CLAUDE_CODE_OAUTH_TOKEN`, say). The sandbox lets commands read everything else.
   */
  denyRead?: readonly string[];
}

/**
 * Claude Code's Bash sandbox as Factory runs it (`bashSandbox`): every Bash command sandboxed (no
 * `dangerouslyDisableSandbox` escape), approved without a prompt as `bypassPermissions` approves
 * everything else, with Claude's credentials unset inside (`deny`; `mask` would need TLS
 * termination to work over HTTPS). Fail closed: if the sandbox can't start, Claude Code doesn't.
 * The session's git credentials (`GH_TOKEN*`) stay: git and `gh` need them.
 *
 * Commands can't see other processes (macOS: Seatbelt; Linux: bubblewrap's own PID namespace and
 * `/proc`), so Claude Code's own environment, which holds the credential, is out of reach; reading
 * Claude's saved login (`~/.claude/.credentials.json`) and `denyRead` is refused. Network: under
 * `bypassPermissions` every host stays reachable through the sandbox's proxy (no allow-list, no
 * prompt). On macOS, Go tools (`gh`) verify TLS through `trustd`, which needs
 * `enableWeakerNetworkIsolation`; with every host already reachable it opens nothing new.
 * Writes: the checkout, the temp directory and {@link BASH_SANDBOX_WRITABLE_HOME_DIRS}; Claude
 * Code keeps `.git/config`, `.git/hooks` and `.claude/` settings read-only even in the checkout.
 */
export function claudeAgentBashSandbox(options: ClaudeAgentBashSandboxOptions = {}) {
  const denyRead = ['~/.claude/.credentials.json', ...(options.denyRead ?? [])];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    enableWeakerNetworkIsolation: true,
    filesystem: { allowWrite: BASH_SANDBOX_WRITABLE_HOME_DIRS.map(dir => `~/${dir}`) },
    credentials: {
      envVars: CLAUDE_CREDENTIAL_ENV.map(name => ({ name, mode: 'deny' as const })),
      files: [...new Set(denyRead)].map(path => ({ path, mode: 'deny' as const })),
    },
  };
}

/** {@link claudeAgentBashSandbox} with no extra `denyRead`. */
export const CLAUDE_AGENT_BASH_SANDBOX = claudeAgentBashSandbox();

/** What Claude Code's Bash sandbox needs on Linux (Debian/Ubuntu package names). */
export const BASH_SANDBOX_PACKAGES = ['bubblewrap', 'socat'] as const;

/**
 * The step that gives a Linux sandbox (a Sprite) what Claude Code's Bash sandbox needs, as one
 * idempotent `sh` script: nothing when `bwrap` and `socat` are there, else the distribution's own
 * packages through `apt-get` (which checks them against the archive's signed index), as root via
 * `sudo -n`. No credential is involved. The rest (unmasking `/proc`, dropping capabilities, a trial
 * sandbox) happens at every launch (`claudeCodeLaunchScript`), since a restart can undo it.
 */
export function bashSandboxInstallScript(options: { systemPath?: string } = {}): string {
  const systemPath = options.systemPath ?? SYSTEM_PATH;
  if (!/^\/[A-Za-z0-9._/:-]+$/.test(systemPath)) throw new Error(`Not a plain PATH: ${systemPath}`);
  const packages = BASH_SANDBOX_PACKAGES.join(' ');
  return [
    'set -u',
    `PATH='${systemPath}'`,
    'export PATH',
    'ready() { command -v bwrap >/dev/null 2>&1 && command -v socat >/dev/null 2>&1; }',
    'if ! ready; then',
    `  command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null || { echo "Claude Code's Bash sandbox needs ${packages}, and this sandbox can't install them (no apt-get, or no passwordless sudo)" >&2; exit 1; }`,
    `  install() { sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${packages} >/dev/null; }`,
    '  install || { sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null && install; } || exit 1',
    `  ready || { echo "${packages} did not install" >&2; exit 1; }`,
    'fi',
    'echo "factory-bash-sandbox bwrap=$(command -v bwrap) socat=$(command -v socat)"',
  ].join('\n');
}

/**
 * Make sure a Linux sandbox has what Claude Code's Bash sandbox needs (see
 * {@link bashSandboxInstallScript}); safe to call on every open.
 */
export async function ensureBashSandbox(run: RunInSandbox, options: { systemPath?: string } = {}): Promise<void> {
  const result = await run(bashSandboxInstallScript(options));
  if (result.exitCode === 0 && /^factory-bash-sandbox /m.test(result.stdout)) return;
  const detail = (result.stderr.trim() || result.stdout.trim()).replace(/wss?:\/\/\S+/g, '<url>').slice(-500);
  throw new Error(
    `Claude Code's Bash sandbox could not be set up in the session's sandbox (exit ${result.exitCode})${
      detail ? `: ${detail}` : ''
    }. Set FACTORY_CLAUDE_AGENT_BASH_SANDBOX=0 to run trusted sessions without it.`,
  );
}
