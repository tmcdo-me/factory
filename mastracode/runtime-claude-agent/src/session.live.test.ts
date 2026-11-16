/**
 * Live check against the real, unmodified Claude Code binary bundled with the Agent SDK, using the
 * machine's own Claude login. Opt-in: `CLAUDE_AGENT_LIVE=1 pnpm test src/session.live.test.ts`.
 * It sends one small prompt, so it costs a few cents of ordinary usage on whatever account the
 * `claude` binary is signed in to.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTranscript } from '@factory/agent-runtime';
import type { EventEnvelope, FactoryEvent, ToolItem } from '@factory/agent-runtime';
import { describe, expect, it } from 'vitest';

import { claudeProcessEnv } from './env';
import { ClaudeAgentSession } from './session';

describe.skipIf(!process.env.CLAUDE_AGENT_LIVE)('ClaudeAgentSession (live Claude Code)', () => {
  it('runs a real turn with a Bash call and maps it into a transcript', { timeout: 180_000 }, async () => {
    const root = process.env.TMPDIR ?? tmpdir();
    mkdirSync(root, { recursive: true });
    const cwd = mkdtempSync(join(root, 'factory-claude-live-'));
    const events: FactoryEvent[] = [];
    const session = new ClaudeAgentSession({
      sessionId: 'live',
      cwd,
      env: claudeProcessEnv(process.env),
      model: process.env.CLAUDE_AGENT_LIVE_MODEL ?? 'claude-haiku-5-5',
      emit: event => events.push(event),
    });

    await session.send({
      text: 'Use your Bash tool to run exactly `echo factory-live`, then reply with only the word: done',
    });
    const deadline = Date.now() + 170_000;
    while (!events.some(e => e.type === 'run.ended') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await session.close();

    const transcript = buildTranscript(
      'live',
      events.map((event, index): EventEnvelope => ({ sessionId: 'live', seq: index + 1, at: 't', event })),
    );
    const run = transcript.items.find(item => item.kind === 'run');
    expect(run).toMatchObject({ status: 'complete' });
    const bash = transcript.items.find((item): item is ToolItem => item.kind === 'tool' && item.name === 'Bash');
    expect(bash).toMatchObject({
      category: 'shell',
      executor: 'runtime',
      status: 'done',
      input: { command: 'echo factory-live' },
    });
    expect(bash!.stdout).toContain('factory-live');
    const replies = transcript.items.filter(item => item.kind === 'message' && item.role === 'assistant');
    expect(JSON.stringify(replies).toLowerCase()).toContain('done');
    expect(session.runtimeState().claudeSessionId).toBeTruthy();
    expect(transcript.usage?.outputTokens).toBeGreaterThan(0);
  });
});
