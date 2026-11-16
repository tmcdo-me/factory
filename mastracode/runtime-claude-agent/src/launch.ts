import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxProcesses } from '@factory/agent-runtime';

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

/**
 * Claude Code inside a sandbox: the SDK starts the sandbox's installed binary through the sandbox's
 * `spawn` and talks to it over stdio exactly as to a local process. Its MCP traffic (Factory's
 * in-process `factory` server) and control requests travel on that same stdio, so they need no
 * network path back to Factory.
 */
export function sandboxClaudeCodeLaunch(
  processes: Pick<SandboxProcesses, 'spawn' | 'files'>,
  installed: Pick<InstalledClaudeCode, 'home' | 'executable'>,
): ClaudeCodeLaunch {
  return {
    home: installed.home,
    remote: true,
    files: processes.files,
    // The SDK spawns this path itself (no `node`); it only exists inside the sandbox.
    pathToClaudeCodeExecutable: installed.executable,
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) =>
      processes.spawn(command, args, {
        cwd: cwd ?? installed.home,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
        signal,
      }),
  };
}
