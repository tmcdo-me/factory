import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Installing Claude Code in a sandbox (a Sprite) that runs it remotely. Factory never ships or
 * modifies the binary: the sandbox runs Anthropic's official installer, pinned to the version the
 * Agent SDK in this build was released with, so the SDK and the CLI it drives always match.
 */

/** Anthropic's official native installer. */
export const CLAUDE_CODE_INSTALLER_URL = 'https://claude.ai/install.sh';

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

let bundled: string | undefined;

/**
 * The Claude Code version the Agent SDK bundles: its package's `claudeCodeVersion`, the version of
 * the CLI it was built and tested against. Read from the installed SDK, never hard-coded, so an SDK
 * upgrade moves the sandboxes' pin with it.
 */
export function bundledClaudeCodeVersion(): string {
  if (bundled) return bundled;
  const require = createRequire(import.meta.url);
  const manifest = join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json');
  const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { claudeCodeVersion?: unknown }).claudeCodeVersion;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`The Claude Agent SDK at ${manifest} names no bundled Claude Code version`);
  }
  bundled = version;
  return version;
}

/** Where Claude Code lives in the sandbox, as the install step reported it. */
export interface InstalledClaudeCode {
  version: string;
  /** Claude Code's own HOME in the sandbox: `<home>/.claude` keeps its config and transcripts. */
  home: string;
  /** The installed executable (`<home>/.local/bin/claude`). */
  executable: string;
}

/** Runs one shell script in the sandbox to completion. */
export type RunInSandbox = (script: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const REPORT = /^factory-claude-code home=(\/\S*) bin=(\/\S*)$/m;

/**
 * The install step, as one idempotent `sh` script: when the sandbox already has Claude Code at
 * `version` it does nothing; otherwise it runs the official installer for exactly that version.
 * Claude Code gets a home of its own under the sandbox user's (`~/.factory/claude-agent`), which it
 * is installed into and later runs with, so its config and transcripts stay together on the
 * sandbox's disk. Auto-update stays off: the binary only ever changes by this script's pin.
 * No credential is involved: the installer and `--version` need none.
 */
export function claudeCodeInstallScript(version: string): string {
  if (!VERSION.test(version)) throw new Error(`Not a Claude Code version: ${JSON.stringify(version)}`);
  return [
    'set -eu',
    'home="${HOME:?}/.factory/claude-agent"',
    'bin="$home/.local/bin/claude"',
    `want='${version}'`,
    'current() { HOME="$home" DISABLE_AUTOUPDATER=1 "$bin" --version 2>/dev/null || true; }',
    'pinned() { case "$(current)" in "$want" | "$want "*) return 0 ;; *) return 1 ;; esac; }',
    'if ! { [ -x "$bin" ] && pinned; }; then',
    '  mkdir -p "$home"',
    `  curl -fsSL ${CLAUDE_CODE_INSTALLER_URL} | HOME="$home" DISABLE_AUTOUPDATER=1 bash -s "$want"`,
    '  pinned || { echo "installed version is $(current), wanted $want" >&2; exit 1; }',
    'fi',
    'echo "factory-claude-code home=$home bin=$bin"',
  ].join('\n');
}

/**
 * Make sure the sandbox has Claude Code at the SDK's bundled version (installing it the first
 * time), and say where it is. Safe to call on every start: an installed sandbox answers with one
 * `--version`.
 */
export async function ensureClaudeCode(
  run: RunInSandbox,
  options: { version?: string } = {},
): Promise<InstalledClaudeCode> {
  const version = options.version ?? bundledClaudeCodeVersion();
  const result = await run(claudeCodeInstallScript(version));
  const report = result.exitCode === 0 ? REPORT.exec(result.stdout) : null;
  if (!report) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
    throw new Error(
      `Claude Agent could not be installed in the session's sandbox (version ${version}, exit ${result.exitCode})${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return { version, home: report[1]!, executable: report[2]! };
}
