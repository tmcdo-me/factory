// fork(claude-agent): the processes a session's sandbox runs for a runtime that launches its own agent in it.
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';

import { sandboxProcessesOf } from '@factory/agent-runtime';
import type { SandboxProcess, SandboxProcesses } from '@factory/agent-runtime';

/** A local sandbox's processes: child processes and files on this host. */
export const LOCAL_SANDBOX_PROCESSES: SandboxProcesses = {
  kind: 'local',
  spawn: (command, args, options) =>
    spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
      ...(options.signal ? { signal: options.signal } : {}),
    }) as unknown as SandboxProcess,
  files: {
    mkdir: async path => {
      await mkdir(path, { recursive: true });
    },
    rm: path => rm(path, { recursive: true, force: true }),
    writeFile: (path, content) => writeFile(path, content),
    isDirectory: path =>
      stat(path).then(
        info => info.isDirectory(),
        () => false,
      ),
  },
};

/**
 * The long-lived processes and files a session's sandbox offers: its provider's own (a Sprite's,
 * `SANDBOX_PROCESSES`), or this host's for a local sandbox. Undefined for a provider that offers
 * none (Platform, E2B): nothing can be launched in it but commands.
 */
export function sessionSandboxProcesses(sandbox: unknown): SandboxProcesses | undefined {
  const own = sandboxProcessesOf(sandbox);
  if (own) return own;
  // By provider, not `instanceof`: a host may load more than one copy of @mastra/core.
  return (sandbox as { provider?: unknown } | null)?.provider === 'local' ? LOCAL_SANDBOX_PROCESSES : undefined;
}
