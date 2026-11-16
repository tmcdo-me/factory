/**
 * Live check against a real Fly.io Sprite. Opt-in, and it needs the operator's own Sprites token:
 *
 *   FACTORY_SPRITES_LIVE=1 SPRITES_TOKEN=… pnpm --filter @factory/sandbox-sprites exec vitest run src/sprites.live.test.ts
 *
 * It creates one Sprite (`factory-live-<time>`), and deletes it afterwards unless
 * `FACTORY_SPRITES_LIVE_KEEP=1`. Without a Claude credential it checks the pinned install, the
 * environment over stdin, and Factory's MCP server and skills reaching Claude Code in the Sprite,
 * with no turn. With `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and
 * `FACTORY_SPRITES_LIVE_TURN=1` it also runs one small turn, closes Claude Code, and resumes the
 * conversation from the Sprite's disk in a new process (a few cents of ordinary usage).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { defineFactoryTool, sandboxProcessesOf } from '@factory/agent-runtime';
import type { FactoryEvent } from '@factory/agent-runtime';
import {
  CLAUDE_AGENT_ISOLATION,
  ClaudeAgentSession,
  bundledClaudeCodeVersion,
  claudeProcessEnv,
  createFactoryMcpServer,
  ensureClaudeCode,
  sandboxClaudeCodeLaunch,
  writeSkillsPlugin,
} from '@factory/runtime-claude-agent';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SpritesFactorySandbox } from './factory-sandbox';

const live = Boolean(process.env.FACTORY_SPRITES_LIVE && process.env.SPRITES_TOKEN);

describe.skipIf(!live)('Claude Agent in a live Sprite', () => {
  it(
    'installs the pinned Claude Code and runs it with Factory tools and skills',
    { timeout: 15 * 60_000 },
    async () => {
      const region = process.env.FACTORY_SPRITES_REGION?.trim();
      const sandbox = new SpritesFactorySandbox({
        token: process.env.SPRITES_TOKEN!,
        ...(region ? { spriteConfig: { region } } : {}),
      }).create({ sessionId: `live-${Date.now().toString(36)}`, getRepositoryAccess: undefined });
      try {
        await sandbox.start();
        const processes = sandboxProcessesOf(sandbox)!;

        // The environment arrives over stdin, and stdin goes on to the command untouched.
        const echo = processes.spawn('sh', ['-c', 'printf "%s|" "$FACTORY_LIVE_VALUE"; head -n 1'], {
          cwd: '/',
          env: { FACTORY_LIVE_VALUE: 'from-the-environment' },
        });
        let out = '';
        echo.stdout.setEncoding('utf8');
        echo.stdout.on('data', (chunk: string) => (out += chunk));
        echo.stdin.end('after-the-preamble\n');
        await new Promise(resolve => echo.once('exit', resolve));
        expect(out).toBe('from-the-environment|after-the-preamble\n');

        // The official installer, pinned to the SDK's bundled version; a second call finds it.
        const run = (script: string) => sandbox.executeCommand!(script, undefined, { timeout: 10 * 60_000 });
        const installed = await ensureClaudeCode(run);
        expect(installed.version).toBe(bundledClaudeCodeVersion());
        expect(await ensureClaudeCode(run)).toEqual(installed);

        const launch = sandboxClaudeCodeLaunch(processes, installed);
        const checkout = `${installed.home}/live-checkout`;
        await processes.files.mkdir(checkout);
        const skills = await writeSkillsPlugin(
          `${installed.home}/factory-skills/live`,
          [{ name: 'factory-plan', description: 'Plan the work', instructions: '# Factory Plan' }],
          launch.files,
        );
        const probe = defineFactoryTool({
          name: 'factory_probe',
          description: 'Probe',
          input: z.object({ item: z.string() }),
          execute: async ({ item }) => ({ item }),
        });
        const options = {
          cwd: checkout,
          env: claudeProcessEnv(process.env, {}, { home: installed.home, remote: true }),
          pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable!,
          spawnClaudeCodeProcess: launch.spawnClaudeCodeProcess!,
        };

        // No turn: Claude Code starts in the Sprite, connects Factory's in-process MCP server over its
        // stdio and loads the skills plugin written on the Sprite's disk.
        let release!: () => void;
        const idle = new Promise<void>(resolve => (release = resolve));
        const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
          await idle;
        })();
        const claude = query({
          prompt,
          options: {
            ...options,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            settingSources: ['project'],
            settings: { ...CLAUDE_AGENT_ISOLATION },
            strictMcpConfig: true,
            mcpServers: {
              factory: createFactoryMcpServer(
                { defs: [probe], context: async () => ({}) as never },
                { currentRunId: () => undefined, newId: () => 'id' },
              ),
            },
            plugins: [skills.plugin],
            skills: skills.names,
          },
        });
        try {
          expect((await claude.supportedCommands()).map(command => command.name)).toContain('factory:factory-plan');
          await vi.waitFor(
            async () =>
              expect(await claude.mcpServerStatus()).toEqual([
                expect.objectContaining({ name: 'factory', status: 'connected' }),
              ]),
            { timeout: 60_000, interval: 500 },
          );
        } finally {
          release();
          claude.close();
        }

        if (!process.env.FACTORY_SPRITES_LIVE_TURN || !process.env.CLAUDE_CODE_OAUTH_TOKEN) return;

        // One turn, then a new Claude Code process resuming it from the Sprite's disk.
        const turn = async (resume: string | undefined, text: string) => {
          const events: FactoryEvent[] = [];
          const session = new ClaudeAgentSession({
            sessionId: 'live',
            ...options,
            ...(resume ? { resume } : {}),
            model: process.env.CLAUDE_AGENT_LIVE_MODEL ?? 'claude-haiku-5-5',
            emit: event => events.push(event),
          });
          await session.send({ text });
          await vi.waitFor(() => expect(events.some(event => event.type === 'run.ended')).toBe(true), {
            timeout: 180_000,
            interval: 500,
          });
          await session.close();
          const assistant = new Set(
            events.flatMap(event =>
              event.type === 'message.started' && event.role === 'assistant' ? [event.messageId] : [],
            ),
          );
          const reply = events
            .flatMap(event => (event.type === 'message.delta' && assistant.has(event.messageId) ? [event.delta] : []))
            .join('');
          return { reply, claudeSessionId: session.runtimeState().claudeSessionId };
        };
        const first = await turn(undefined, 'Remember the word "heliotrope". Reply with only: ok');
        expect(first.claudeSessionId).toBeTruthy();
        const second = await turn(first.claudeSessionId, 'Which word did I ask you to remember? Reply with only it.');
        expect(second.reply.toLowerCase()).toContain('heliotrope');
      } finally {
        if (!process.env.FACTORY_SPRITES_LIVE_KEEP) await sandbox.destroy();
        else await sandbox.stop();
      }
    },
  );
});
