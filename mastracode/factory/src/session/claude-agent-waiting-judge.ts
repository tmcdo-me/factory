// fork(claude-agent): whether a board run's turn ended waiting on a person, judged by Claude Code itself.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { claudeProcessEnv, judgeWaitingOnPerson } from '@factory/runtime-claude-agent';
import type { QueryFn, WaitingVerdict } from '@factory/runtime-claude-agent';

/**
 * The judge Claude Agent sessions ask (see `ClaudeAgentSessionsDeps.waitingJudge`): one turn of the
 * unmodified Claude Code on this host, through the Agent SDK, with Claude Agent's own home and
 * credential (`claudeProcessEnv`, as a session gets them) and an empty folder of its own under that
 * home as its working directory. Factory never calls a model API itself.
 */
export function claudeAgentWaitingJudge(options: {
  home: string;
  hostEnv?: Record<string, string | undefined>;
  query?: QueryFn;
}): (input: { objective: string; text: string }) => Promise<WaitingVerdict | undefined> {
  const cwd = join(options.home, 'goal-judge');
  return async input => {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return judgeWaitingOnPerson(input, {
      env: claudeProcessEnv(options.hostEnv ?? process.env, {}, { home: options.home }),
      cwd,
      ...(options.query ? { query: options.query } : {}),
    });
  };
}
