// fork(claude-agent): whether a board run's turn ended waiting on a person, judged by Claude Code itself.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { claudeProcessEnv, judgeWaitingOnPerson } from '@factory/runtime-claude-agent';
import type { QueryFn, WaitingVerdict } from '@factory/runtime-claude-agent';

/** An installed `claude` the host runs instead of the SDK's bundled one: `FACTORY_CLAUDE_AGENT_EXECUTABLE`. */
export function claudeAgentExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.FACTORY_CLAUDE_AGENT_EXECUTABLE?.trim() || undefined;
}

/**
 * The judge Claude Agent sessions ask (see `ClaudeAgentSessionsDeps.waitingJudge`): one turn of the
 * unmodified Claude Code on this host, through the Agent SDK, with Claude Agent's own home and
 * credential (`claudeProcessEnv`, as a session gets them), the same binary local sessions run, and an
 * empty folder of its own under that home as its working directory. Factory never calls a model API
 * itself. A failure is logged once until the judge decides again (a missing login shows there, and so
 * does it coming back after it worked).
 */
export function claudeAgentWaitingJudge(options: {
  home: string;
  hostEnv?: Record<string, string | undefined>;
  query?: QueryFn;
  log?: (message: string, error: unknown) => void;
}): (input: { objective: string; text: string }) => Promise<WaitingVerdict | undefined> {
  const cwd = join(options.home, 'goal-judge');
  const hostEnv = options.hostEnv ?? process.env;
  const executable = claudeAgentExecutable(hostEnv);
  const log = options.log ?? ((message, error) => console.warn(message, error));
  let logged = false;
  return async input => {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const verdict = await judgeWaitingOnPerson(input, {
      env: claudeProcessEnv(hostEnv, {}, { home: options.home }),
      cwd,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(options.query ? { query: options.query } : {}),
      onError: error => {
        if (logged) return;
        logged = true;
        log(
          '[factory] The goal judge (Claude Code, one turn) gave no verdict; turns that end asking a person are re-kicked until it does. Failures are not logged again until it has decided once.',
          error,
        );
      },
    });
    if (verdict) logged = false;
    return verdict;
  };
}
