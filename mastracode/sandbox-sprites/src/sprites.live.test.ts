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
 * conversation from the Sprite's disk in a new process (a few cents of ordinary usage), and one
 * turn in Claude Code's Bash sandbox, as Factory runs it by default, whose probe checks that no
 * command gets at Claude's credential while ordinary work still goes.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { defineFactoryTool, sandboxProcessesOf } from '@factory/agent-runtime';
import type { FactoryEvent } from '@factory/agent-runtime';
import type { InstalledClaudeCode } from '@factory/runtime-claude-agent';
import {
  CLAUDE_AGENT_ISOLATION,
  ClaudeAgentSession,
  bashSandboxProbeScript,
  bundledClaudeCodeChecksums,
  bundledClaudeCodeVersion,
  claudeProcessEnv,
  createFactoryMcpServer,
  ensureBashSandbox,
  ensureClaudeCode,
  runInProcesses,
  parseBashSandboxProbe,
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
      let prepared: InstalledClaudeCode | undefined;
      const sandbox = new SpritesFactorySandbox({
        token: process.env.SPRITES_TOKEN!,
        namePrefix: 'factorylivecheck', // not `factory-…`, so it never looks like a session's
        ...(region ? { spriteConfig: { region } } : {}),
        // As the web host does: install before any setup would run.
        prepare: async processes => {
          prepared = await ensureClaudeCode(runInProcesses(processes));
          await ensureBashSandbox(runInProcesses(processes));
        },
      }).create({ sessionId: Date.now().toString(36), getRepositoryAccess: undefined });
      try {
        await sandbox.start();
        const processes = sandboxProcessesOf(sandbox)!;

        // The Sprite user is not root (Claude Code refuses bypassPermissions as root).
        expect((await sandbox.executeCommand!('id -u')).stdout.trim()).not.toBe('0');

        // The environment arrives over stdin (newlines too), and stdin goes on to the command untouched.
        const echo = processes.spawn('sh', ['-c', 'printf "%s|" "$FACTORY_LIVE_VALUE"; head -n 1'], {
          cwd: '/',
          env: { FACTORY_LIVE_VALUE: 'from-the\nenvironment' },
        });
        let out = '';
        echo.stdout.setEncoding('utf8');
        echo.stdout.on('data', (chunk: string) => (out += chunk));
        echo.stdin.end('after-the-preamble\n');
        await new Promise(resolve => echo.once('exit', resolve));
        expect(out).toBe('from-the\nenvironment|after-the-preamble\n');

        // Commands get the sandbox env the same way, and a failing exec's error carries no URL.
        sandbox.setEnv(env => ({ ...env, FACTORY_LIVE_SECRET: 'live-secret-value' }));
        expect((await sandbox.executeCommand!('printf %s "$FACTORY_LIVE_SECRET"')).stdout).toBe('live-secret-value');

        // The official installer, pinned to the SDK's bundled version; a second call finds it.
        // The official installer ran in prepare, pinned and checksum-verified; a second check finds it.
        expect(prepared?.version).toBe(bundledClaudeCodeVersion());
        expect(bundledClaudeCodeChecksums()).toContain(prepared!.checksum);
        const installed = await ensureClaudeCode(runInProcesses(processes));
        expect(installed).toEqual(prepared);

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
          // A stand-in for the session's GitHub token: git and gh in the sandbox must still get it.
          env: claudeProcessEnv(
            process.env,
            { GH_TOKEN: 'ghs_factorylive000000000000000000000000' },
            { home: installed.home, remote: true },
          ),
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
        const turn = async (resume: string | undefined, text: string, bashSandbox = false) => {
          const events: FactoryEvent[] = [];
          const sandboxed = bashSandbox ? sandboxClaudeCodeLaunch(processes, installed, { bashSandbox }) : launch;
          const session = new ClaudeAgentSession({
            sessionId: 'live',
            ...options,
            pathToClaudeCodeExecutable: sandboxed.pathToClaudeCodeExecutable!,
            spawnClaudeCodeProcess: sandboxed.spawnClaudeCodeProcess!,
            ...(resume ? { resume } : {}),
            ...(bashSandbox ? { bashSandbox } : {}),
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
          const toolOutput = events.flatMap(event => (event.type === 'tool.output' ? [event.chunk] : [])).join('');
          return { reply, toolOutput, claudeSessionId: session.runtimeState().claudeSessionId };
        };
        const first = await turn(undefined, 'Remember the word "heliotrope". Reply with only: ok');
        expect(first.claudeSessionId).toBeTruthy();
        const second = await turn(first.claudeSessionId, 'Which word did I ask you to remember? Reply with only it.');
        expect(second.reply.toLowerCase()).toContain('heliotrope');

        // 9c, in Claude Code's Bash sandbox: Claude's credential is out of its commands' reach (their
        // environment, Claude Code's own through /proc, files), and ordinary work still goes.
        // `prepare` installed bubblewrap and socat.
        expect((await sandbox.executeCommand!('command -v bwrap && command -v socat')).exitCode).toBe(0);
        // The container masks parts of /proc until a launch takes them off (they return on a restart).
        const masks = await sandbox.executeCommand!(
          `awk '$5 ~ "^/proc/" { n++ } END { print n + 0 }' /proc/self/mountinfo`,
        );
        console.log(`[live] /proc masks before the sandboxed launch: ${masks.stdout.trim()}`);
        await processes.files.writeFile(`${checkout}/probe.sh`, bashSandboxProbeScript());
        await sandbox.executeCommand!(`git init -q '${checkout}'`);
        const sandboxed = await turn(
          undefined,
          'Use your Bash tool to run exactly `sh ./probe.sh` (one call), then reply with only: done',
          true,
        );
        console.log(`[live] sandbox probe:\n${sandboxed.toolOutput}`);
        expect(parseBashSandboxProbe(sandboxed.toolOutput)).toMatchObject({
          'env.CLAUDE_CODE_OAUTH_TOKEN': 'absent',
          'env.GH_TOKEN': 'present',
          'ps.token_in_env': '0',
          'proc.token_in_environ': '0',
          'files.token_like': '0',
          'net.npm_registry': '200',
          'git.public': 'ok',
          'git.credential_helper': 'sent',
          'gh.api': 'reached',
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
      } finally {
        if (!process.env.FACTORY_SPRITES_LIVE_KEEP) await sandbox.destroy();
        else await sandbox.stop();
      }
    },
  );
});
