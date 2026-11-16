// fork(claude-agent)
/**
 * Live check of Factory's Claude Agent sessions against the real, unmodified Claude Code bundled with
 * the Agent SDK, on this host. Opt-in: `CLAUDE_AGENT_LIVE=1` with `CLAUDE_CODE_OAUTH_TOKEN` (from
 * `claude setup-token`) in the environment; two small turns on that account.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryEventLog, SessionEventHub, buildTranscript } from '@factory/agent-runtime';
import type { ToolItem } from '@factory/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeAgentSessions } from './claude-agent-sessions.js';

const live = Boolean(process.env.CLAUDE_AGENT_LIVE && process.env.CLAUDE_CODE_OAUTH_TOKEN);

describe.skipIf(!live)('ClaudeAgentSessions (live Claude Code)', () => {
  // 9c: Read, Grep and the other file tools run in Claude Code's own process, outside the Bash
  // sandbox. A file holding Claude's credential (here a stand-in, named the way an operator names
  // theirs: FACTORY_CLAUDE_AGENT_BASH_DENY_READ) must be refused to them, while the checkout reads.
  it(
    "refuses Claude's file tools a FACTORY_CLAUDE_AGENT_BASH_DENY_READ file, and still reads the checkout",
    {
      timeout: 300_000,
    },
    async () => {
      const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'factory-claude-file-deny-'));
      const cwd = join(root, 'repo');
      const home = join(root, 'home');
      const secretDir = join(root, 'secrets');
      const secretFile = join(secretDir, 'claude.env');
      const fake = 'not-a-secret-123';
      mkdirSync(cwd, { recursive: true });
      mkdirSync(secretDir);
      writeFileSync(secretFile, `FAKE_CLAUDE_TOKEN=${fake}\n`);
      writeFileSync(join(cwd, 'notes.txt'), 'ordinary-content-456\n');
      // The same file reached through a link in the checkout.
      symlinkSync(secretFile, join(cwd, 'linked.env'));
      execFileSync('git', ['init', '-q'], { cwd });

      const log = new InMemoryEventLog();
      const record = {
        sessionId: 'live-file-deny',
        runtimeId: 'claude-agent',
        modelId: process.env.CLAUDE_AGENT_LIVE_MODEL ?? 'claude-haiku-5-5',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const sessions = new ClaudeAgentSessions({
        hub: new SessionEventHub(log),
        sessions: { get: async () => record, setRuntimeState: async () => undefined, setModel: async () => undefined },
        workspace: async () => ({ cwd, env: {} }),
        home,
        hostEnv: { ...process.env, FACTORY_CLAUDE_AGENT_BASH_DENY_READ: secretFile },
        bashSandbox: true,
        idleCloseMs: 0,
      });
      const commands = sessions.commands();
      const turn = async (text: string, runs: number) => {
        await commands.send(record.sessionId, { text }, { context: undefined });
        await vi.waitFor(
          async () =>
            expect((await log.list(record.sessionId)).filter(e => e.event.type === 'run.ended')).toHaveLength(runs),
          { timeout: 140_000, interval: 500 },
        );
      };
      try {
        await turn(
          [
            'Use only your Read and Grep tools for this, never Bash, and do not retry anything another way.',
            `1. Read the file ${secretFile}`,
            '2. Read the file ./linked.env',
            `3. Grep for FAKE_CLAUDE_TOKEN in ${secretDir} with output mode "content".`,
            'Then reply with only: done',
          ].join('\n'),
          1,
        );
        await turn('Read ./notes.txt with your Read tool and reply with only its contents.', 2);

        const events = await log.list(record.sessionId);
        const transcript = buildTranscript(record.sessionId, events);
        const tools = transcript.items.filter((item): item is ToolItem => item.kind === 'tool');
        console.log(
          '[live] tools:',
          JSON.stringify(tools.map(t => ({ name: t.name, input: t.input, status: t.status, error: t.error }))),
        );
        const reads = (path: string) =>
          tools.filter(t => t.name === 'Read' && String((t.input as { file_path?: string })?.file_path).endsWith(path));
        // Refused, not merely empty: the deny rule answers, not the file system.
        expect(reads(secretFile).length).toBeGreaterThan(0);
        for (const read of reads(secretFile)) expect(read.status).toBe('error');
        for (const read of reads('linked.env')) expect(read.status).toBe('error');
        // The stand-in value appears nowhere: no tool result, no reply, no notice.
        expect(JSON.stringify(events)).not.toContain(fake);
        // The checkout's own files still read.
        expect(reads('notes.txt').some(read => read.status === 'done')).toBe(true);
        const replies = transcript.items.filter(item => item.kind === 'message' && item.role === 'assistant');
        expect(JSON.stringify(replies)).toContain('ordinary-content-456');
      } finally {
        await sessions.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
