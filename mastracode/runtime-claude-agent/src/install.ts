import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { SandboxProcesses } from '@factory/agent-runtime';

/**
 * Installing Claude Code in a sandbox (a Sprite) that runs it remotely. Factory never ships or
 * modifies the binary: the sandbox runs Anthropic's official installer, pinned to the version the
 * Agent SDK in this build was released with, and the installed binary must match that release's
 * published SHA-256 (the SDK's own `manifest.json` carries the same checksums as the release
 * manifest on downloads.claude.ai), at install and at every launch (`launch.ts`).
 */

/** Anthropic's official native installer. */
export const CLAUDE_CODE_INSTALLER_URL = 'https://claude.ai/install.sh';

/** Where Claude Code reads managed (policy) settings on Linux; they load even with `settingSources: []`. */
export const CLAUDE_CODE_MANAGED_DIR = '/etc/claude-code';

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface SdkRelease {
  version: string;
  /** SHA-256 of each Linux build of that version's binary. */
  linuxChecksums: string[];
}

let bundled: SdkRelease | undefined;

function sdkRelease(): SdkRelease {
  if (bundled) return bundled;
  const sdkDir = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as { claudeCodeVersion?: unknown };
  const manifest = JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8')) as {
    version?: unknown;
    platforms?: Record<string, { checksum?: unknown }>;
  };
  const version = pkg.claudeCodeVersion;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`The Claude Agent SDK at ${sdkDir} names no bundled Claude Code version`);
  }
  if (manifest.version !== version) {
    throw new Error(`The Claude Agent SDK's binary manifest is for ${String(manifest.version)}, not ${version}`);
  }
  const linuxChecksums = Object.entries(manifest.platforms ?? {})
    .filter(([platform]) => platform.startsWith('linux-'))
    .map(([, entry]) => entry.checksum)
    .filter((checksum): checksum is string => typeof checksum === 'string' && SHA256.test(checksum));
  if (!linuxChecksums.length) throw new Error(`The Claude Agent SDK's binary manifest has no Linux checksums`);
  bundled = { version, linuxChecksums };
  return bundled;
}

/**
 * The Claude Code version the Agent SDK bundles: its package's `claudeCodeVersion`, the version of
 * the CLI it was built and tested against. Read from the installed SDK, never hard-coded, so an SDK
 * upgrade moves the sandboxes' pin with it.
 */
export function bundledClaudeCodeVersion(): string {
  return sdkRelease().version;
}

/** The published SHA-256 of every Linux build of the bundled version (from the SDK's manifest). */
export function bundledClaudeCodeChecksums(): string[] {
  return [...sdkRelease().linuxChecksums];
}

/** Where Claude Code lives in the sandbox, as the install step verified it. */
export interface InstalledClaudeCode {
  version: string;
  /** Claude Code's own HOME in the sandbox: `<home>/.claude` keeps its config and transcripts. */
  home: string;
  /** The installed binary itself (symlinks resolved), the only path ever launched. */
  executable: string;
  /** Its SHA-256, one of the release's: checked again at every launch. */
  checksum: string;
}

/** Runs one shell script in the sandbox to completion. */
export type RunInSandbox = (script: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const REPORT = /^factory-claude-code home=(\/\S*) bin=(\/\S*) sha256=([a-f0-9]{64})$/m;

/** Shell: `sha256 FILE` prints the file's SHA-256 (coreutils, or `shasum` where that is missing). */
export const SHA256_SHELL =
  'sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d" " -f1; }';

/** Shell: fails, saying so, when the managed-settings directory holds anything. */
export function managedSettingsCheck(managedDir: string, exitCode: number): string {
  return `if [ -n "$(ls -A '${managedDir}' 2>/dev/null)" ]; then echo "factory: ${managedDir} holds Claude Code managed settings Factory did not write; Claude Agent will not run here" >&2; exit ${exitCode}; fi`;
}

/**
 * The install step, as one idempotent `sh` script. It never runs a binary it has not verified:
 * when `~/.factory/claude-agent/.local/bin/claude` resolves to a file whose SHA-256 is one of the
 * release's, it does nothing; otherwise it runs the official installer for exactly `version`
 * (from Claude's home, so no checkout's `.claude/` is in play) and verifies the result. The verified
 * binary is made read-only, and root-owned where the user may `sudo` without a password. Claude
 * Code's home (`~/.factory/claude-agent`) is the one it later runs with, so config and transcripts
 * stay together on the sandbox's disk. Auto-update stays off. No credential is involved.
 */
export function claudeCodeInstallScript(
  version: string,
  checksums: readonly string[],
  options: { managedDir?: string } = {},
): string {
  if (!VERSION.test(version)) throw new Error(`Not a Claude Code version: ${JSON.stringify(version)}`);
  if (!checksums.length || !checksums.every(checksum => SHA256.test(checksum))) {
    throw new Error('Claude Code checksums must be SHA-256 hex digests');
  }
  const managedDir = options.managedDir ?? CLAUDE_CODE_MANAGED_DIR;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(managedDir)) throw new Error(`Not a plain path: ${managedDir}`);
  return [
    'set -eu',
    'home="${HOME:?}/.factory/claude-agent"',
    'link="$home/.local/bin/claude"',
    `want='${version}'`,
    `sums=' ${checksums.join(' ')} '`,
    SHA256_SHELL,
    'verified() { [ -e "$link" ] || return 1; bin=$(readlink -f "$link") && [ -f "$bin" ] || return 1; sum=$(sha256 "$bin"); case "$sums" in *" $sum "*) return 0 ;; esac; return 1; }',
    managedSettingsCheck(managedDir, 99),
    'if ! verified; then',
    '  mkdir -p "$home"',
    '  cd "$home"',
    `  curl -fsSL ${CLAUDE_CODE_INSTALLER_URL} | HOME="$home" DISABLE_AUTOUPDATER=1 bash -s "$want"`,
    '  verified || { echo "the installed Claude Code $want does not match its published checksum" >&2; exit 1; }',
    'fi',
    'chmod a-w "$bin" 2>/dev/null || true',
    'if sudo -n true 2>/dev/null; then sudo -n chown root:root "$bin" 2>/dev/null || true; fi',
    'echo "factory-claude-code home=$home bin=$bin sha256=$sum"',
  ].join('\n');
}

/**
 * Make sure the sandbox has Claude Code at the SDK's bundled version, verified against its published
 * checksum (installing it the first time, or again when the file was changed), and say where it is.
 * Safe to call on every open: a verified sandbox answers with one checksum.
 */
export async function ensureClaudeCode(
  run: RunInSandbox,
  options: { version?: string; checksums?: readonly string[]; managedDir?: string } = {},
): Promise<InstalledClaudeCode> {
  const version = options.version ?? bundledClaudeCodeVersion();
  const checksums = options.checksums ?? bundledClaudeCodeChecksums();
  const result = await run(
    claudeCodeInstallScript(version, checksums, options.managedDir ? { managedDir: options.managedDir } : {}),
  );
  const report = result.exitCode === 0 ? REPORT.exec(result.stdout) : null;
  if (!report) {
    // The installer's and the script's own messages only; nothing of the exec request.
    const detail = (result.stderr.trim() || result.stdout.trim()).replace(/wss?:\/\/\S+/g, '<url>').slice(-500);
    throw new Error(
      `Claude Agent could not be installed in the session's sandbox (version ${version}, exit ${result.exitCode})${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return { version, home: report[1]!, executable: report[2]!, checksum: report[3]! };
}

/** How long one install may take (a first download of the binary). */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Run scripts through the sandbox's own long-lived processes, with an empty environment: the
 * install needs no credential, so none is anywhere near it (or its errors).
 */
export function runInProcesses(
  processes: Pick<SandboxProcesses, 'spawn'>,
  options: { timeoutMs?: number } = {},
): RunInSandbox {
  return script =>
    new Promise(resolve => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? INSTALL_TIMEOUT_MS);
      timer.unref?.();
      let stdout = '';
      let stderr = '';
      const finish = (exitCode: number, error?: string) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr: error ? `${stderr}${error}` : stderr });
      };
      let process: ReturnType<SandboxProcesses['spawn']>;
      try {
        process = processes.spawn('sh', ['-c', script], { cwd: '/', env: {}, signal: abort.signal });
      } catch (error) {
        finish(1, error instanceof Error ? error.message : String(error));
        return;
      }
      process.stdout.setEncoding('utf8');
      process.stdout.on('data', (chunk: string) => (stdout += chunk));
      process.stderr?.setEncoding('utf8');
      process.stderr?.on('data', (chunk: string) => (stderr += chunk));
      process.on('error', error => {
        stderr += `${error.message}\n`;
      });
      // Output is complete once stdout ended and the process exited, in whichever order they come.
      const ended = new Promise<void>(done => {
        process.stdout.once('end', done);
        process.stdout.once('close', done);
      });
      process.once('exit', code => {
        void ended.then(() => finish(abort.signal.aborted ? 124 : (code ?? 1)));
      });
      process.stdin.end();
    });
}
