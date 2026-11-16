/**
 * Live check against the real, unmodified Claude Code binary bundled with the Agent SDK, using the
 * machine's own Claude login. Opt-in: `CLAUDE_AGENT_LIVE=1 pnpm test src/session.live.test.ts`.
 * It sends two small prompts, so it costs a few cents of ordinary usage on whatever account the
 * `claude` binary is signed in to. With `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) it
 * also runs one turn in Claude Code's Bash sandbox, as Factory runs it on this host (a home of its
 * own, the token in the environment), and checks with a probe that no command gets at the token.
 * On macOS that adds a throwaway keychain item for the turn (standing in for a saved login).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildTranscript, defineFactoryTool } from '@factory/agent-runtime';
import type { EventEnvelope, FactoryEvent, FactoryToolContext, ToolItem } from '@factory/agent-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BASH_SANDBOX_WRITABLE_HOME_DIRS } from './bash-sandbox';
import { bashSandboxProbeScript, parseBashSandboxProbe } from './bash-sandbox-probe';
import { claudeProcessEnv } from './env';
import { ClaudeAgentSession } from './session';
import type { QueryFn } from './session';
import { writeSkillsPlugin } from './skills';

/** The real `query`, with every message Claude Code sends copied to `seen`. */
function tappedQuery(seen: SDKMessage[]): QueryFn {
  return params => {
    const query = sdkQuery(params);
    const tapped = (async function* () {
      for await (const message of query) {
        seen.push(message);
        yield message;
      }
    })();
    return Object.assign(tapped, {
      interrupt: () => query.interrupt(),
      setModel: (model?: string) => query.setModel(model),
      close: () => query.close(),
    }) as unknown as Query;
  };
}

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

  it(
    "invokes a Factory skill that calls a Factory tool, with only Factory's skills and the allowed tools",
    { timeout: 240_000 },
    async () => {
      const root = process.env.TMPDIR ?? tmpdir();
      mkdirSync(root, { recursive: true });
      const cwd = mkdtempSync(join(root, 'factory-claude-live-'));
      const plugin = join(cwd, '..', `${cwd.split('/').at(-1)}-plugin`);
      const skills = await writeSkillsPlugin(plugin, [
        {
          name: 'live-check',
          description: 'Checks the Factory wiring. Use it when asked to run the Factory live check.',
          instructions:
            'Call the Factory tool `factory_echo` with text "from-skill". Then reply with only the word: done',
        },
      ]);
      const calls: { text: string; ctx: FactoryToolContext }[] = [];
      const seen: SDKMessage[] = [];
      const events: FactoryEvent[] = [];
      const session = new ClaudeAgentSession({
        sessionId: 'live-tools',
        cwd,
        env: claudeProcessEnv(process.env),
        model: process.env.CLAUDE_AGENT_LIVE_MODEL ?? 'claude-haiku-5-5',
        emit: event => events.push(event),
        query: tappedQuery(seen),
        skills,
        factoryTools: {
          defs: [
            defineFactoryTool({
              name: 'factory_echo',
              description: 'Echo text back; used by the Factory live check.',
              input: z.object({ text: z.string() }),
              execute: async ({ text }, ctx) => {
                calls.push({ text, ctx });
                return { echoed: text };
              },
            }),
          ],
          context: call => ({
            sessionId: 'live-tools',
            callId: call.callId,
            orgId: 'local',
            userId: 'local',
            workspace: {} as FactoryToolContext['workspace'],
            signal: call.signal,
            interact: async () => {
              throw new Error('unused');
            },
          }),
        },
      });

      try {
        const { runId } = await session.send({ text: 'Run the Factory live check skill (factory:live-check).' });
        const deadline = Date.now() + 230_000;
        while (!events.some(e => e.type === 'run.ended') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        await session.close();

        const init = seen.find(m => m.type === 'system' && m.subtype === 'init') as
          | (SDKMessage & { tools: string[]; skills: string[]; mcp_servers: { name: string; status: string }[] })
          | undefined;
        console.log('[live] init tools:', JSON.stringify(init?.tools));
        console.log('[live] init skills:', JSON.stringify(init?.skills));
        console.log('[live] init mcp servers:', JSON.stringify(init?.mcp_servers));
        expect(init?.mcp_servers).toEqual([{ name: 'factory', status: 'connected', source: 'sdk' }]);
        expect(init?.tools).toContain('mcp__factory__factory_echo');
        expect(init?.tools).toContain('Bash');
        expect(init?.tools).toContain('Skill');
        for (const outside of ['CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'SendMessage']) {
          expect(init?.tools).not.toContain(outside);
        }
        // Claude Code's own built-in plugins (`…@builtin`) still report their skills here; the `skills`
        // allow-list keeps them out of the model's listing and the Skill tool.
        expect(init?.skills).toContain('factory:live-check');

        // The skill ran and called the Factory tool, bound to Claude's tool_use and the run.
        expect(calls.map(call => call.text)).toEqual(['from-skill']);
        const transcript = buildTranscript(
          'live-tools',
          events.map((event, index): EventEnvelope => ({ sessionId: 'live-tools', seq: index + 1, at: 't', event })),
        );
        const echo = transcript.items.find(
          (item): item is ToolItem => item.kind === 'tool' && item.name === 'factory_echo',
        );
        expect(echo).toMatchObject({ category: 'factory', executor: 'factory', status: 'done' });
        expect(calls[0]!.ctx.callId).toBe(echo!.callId);
        expect(transcript.items.find(item => item.kind === 'run')).toMatchObject({ runId, status: 'complete' });
      } finally {
        await session.close();
        await rm(plugin, { recursive: true, force: true });
      }
    },
  );

  // 9c: Claude's Bash commands (a repository's tests) must not get at Claude's credential: not in
  // their environment, not in Claude Code's (`ps eww` / `/proc`), not in a file (the server's env
  // file, Claude's config dir) or the keychain. Ordinary work must still go.
  it.skipIf(!process.env.CLAUDE_CODE_OAUTH_TOKEN)(
    "keeps Claude's credential from its Bash commands on this host, and ordinary work still goes",
    { timeout: 240_000 },
    async () => {
      const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'factory-claude-sandbox-'));
      const cwd = join(root, 'repo');
      const home = join(root, 'home');
      const secretFile = join(root, 'server', '.env');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(root, 'server'));
      for (const dir of BASH_SANDBOX_WRITABLE_HOME_DIRS) mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(secretFile, 'CLAUDE_CODE_OAUTH_TOKEN=stand-in\n');
      execFileSync('git', ['init', '-q'], { cwd });
      const keychainService = process.platform === 'darwin' ? `factory-live-probe-${randomUUID()}` : undefined;
      if (keychainService) {
        execFileSync('security', ['add-generic-password', '-s', keychainService, '-a', 'factory', '-w', randomUUID()]);
      }
      writeFileSync(
        join(cwd, 'probe.sh'),
        bashSandboxProbeScript({ secretFile, ...(keychainService ? { keychainService } : {}) }),
      );
      const events: FactoryEvent[] = [];
      const session = new ClaudeAgentSession({
        sessionId: 'live-sandbox',
        cwd,
        // A stand-in for the session's GitHub token: git and gh must still get it.
        env: claudeProcessEnv(process.env, { GH_TOKEN: 'ghs_factorylive000000000000000000000000' }, { home }),
        model: process.env.CLAUDE_AGENT_LIVE_MODEL ?? 'claude-haiku-5-5',
        bashSandbox: true,
        secretFiles: [secretFile],
        emit: event => events.push(event),
      });
      try {
        await session.send({
          text: 'Use your Bash tool to run exactly `sh ./probe.sh` (one call), then reply with only: done',
        });
        const deadline = Date.now() + 230_000;
        while (!events.some(e => e.type === 'run.ended') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        await session.close();
        const output = events.flatMap(e => (e.type === 'tool.output' ? [e.chunk] : [])).join('');
        console.log('[live] sandbox probe:\n' + output);
        const probe = parseBashSandboxProbe(output);
        expect(probe).toMatchObject({
          'env.CLAUDE_CODE_OAUTH_TOKEN': 'absent',
          'env.GH_TOKEN': 'present',
          'ps.token_in_env': '0',
          'files.token_like': '0',
          'files.secret': 'denied',
          'net.npm_registry': '200',
          'git.public': 'ok',
          'write.checkout': 'ok',
          'write.tmpdir': 'ok',
          'write.home_cache': 'ok',
          'write.home_npm': 'ok',
          'write.claude_config': 'denied',
          'write.checkout_claude_settings': 'denied',
          'write.git_hooks': 'denied',
          'npm.install': 'ok',
          'git.commit': 'ok',
          'git.push': 'ok',
          probe: 'done',
        });
        if (probe['proc.token_in_environ'] !== undefined) expect(probe['proc.token_in_environ']).toBe('0');
        if (keychainService) expect(probe['keychain.item']).toBe('denied');
        if (probe['gh.api'] !== 'not-installed') {
          expect(probe).toMatchObject({ 'git.credential_helper': 'sent', 'gh.api': 'reached' });
        }
      } finally {
        await session.close();
        if (keychainService) execFileSync('security', ['delete-generic-password', '-s', keychainService]);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
