/**
 * The real, unmodified Claude Code binary (the one the Agent SDK bundles for this machine), started
 * the way Factory starts it in a Sprite: through `spawnClaudeCodeProcess` → `spawnInSprite` → a
 * Sprite exec, with its environment over stdin. The exec is the fake one, running locally, so no Fly
 * account is involved. No credential is passed and no turn is sent: the binary starts, connects
 * Factory's in-process MCP server over the exec's stdio, and loads Factory's skills plugin.
 *
 * Opt-in (it runs a ~350 MB binary): `FACTORY_SPRITES_E2E=1 pnpm test src/claude-code.e2e.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { defineFactoryTool } from '@factory/agent-runtime';
import type { SandboxProcesses } from '@factory/agent-runtime';
import {
  CLAUDE_AGENT_ISOLATION,
  HOST_FILES,
  claudeProcessEnv,
  createFactoryMcpServer,
  sandboxClaudeCodeLaunch,
  writeSkillsPlugin,
} from '@factory/runtime-claude-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { envOverStdin } from './sprite-exec';
import { spawnInSprite } from './sprite-process';
import { execUrl, fakeSpriteExec } from './test-utils';

/** A value only the process's environment carries (as a credential would). */
const MARKER = 'only-in-the-environment-7f3a';

/**
 * The SDK's bundled native binary for this machine, standing in for the one installed in a Sprite,
 * with its release checksum from the SDK's manifest (as the install step verifies it).
 */
function bundledBinary(): { executable: string; checksum: string } {
  const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const platform = `${process.platform}-${process.arch}`;
  const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'manifest.json'), 'utf8')) as {
    platforms: Record<string, { checksum: string }>;
  };
  return {
    executable: join(
      dirname(createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`)),
      'claude',
    ),
    checksum: manifest.platforms[platform]!.checksum,
  };
}

describe.skipIf(!process.env.FACTORY_SPRITES_E2E)(
  'Claude Code through a Sprite exec (fake Sprite, real binary)',
  () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'factory-sprite-e2e-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });

    it('starts, serves Factory tools over its stdio, and loads the skills plugin', { timeout: 120_000 }, async () => {
      const raw = fakeSpriteExec();
      const sprite = envOverStdin({ spawn: raw.spawn });
      const processes: SandboxProcesses = {
        kind: 'sprite',
        spawn: (command, args, options) => spawnInSprite(sprite.spawn, command, args, options),
        files: { ...HOST_FILES, isDirectory: async () => true },
      };
      const home = join(root, 'claude-home');
      const cwd = join(root, 'repo');
      await HOST_FILES.mkdir(cwd);
      const launch = sandboxClaudeCodeLaunch(processes, { home, ...bundledBinary() });
      const skills = await writeSkillsPlugin(
        join(home, 'factory-skills', 's1'),
        [{ name: 'factory-plan', description: 'Plan the work', instructions: '# Factory Plan' }],
        launch.files,
      );
      const probe = defineFactoryTool({
        name: 'factory_probe',
        description: 'Probe',
        input: z.object({ item: z.string() }),
        execute: async ({ item }) => ({ item }),
      });
      const server = createFactoryMcpServer(
        { defs: [probe], context: async () => ({}) as never },
        { currentRunId: () => undefined, newId: () => 'id' },
      );

      let release!: () => void;
      const idle = new Promise<void>(resolve => (release = resolve));
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        await idle; // no turn: nothing reaches the model
      })();
      const claude = query({
        prompt,
        options: {
          cwd,
          // No credential of any kind; nonessential traffic off.
          env: claudeProcessEnv(
            {},
            { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', FACTORY_E2E_MARKER: MARKER },
            { home, remote: true },
          ),
          pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable!,
          spawnClaudeCodeProcess: launch.spawnClaudeCodeProcess!,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project'],
          settings: { ...CLAUDE_AGENT_ISOLATION },
          strictMcpConfig: true,
          mcpServers: { factory: server },
          plugins: [skills.plugin],
          skills: skills.names,
        },
      });
      try {
        // Factory's skills plugin, written where Claude Code runs, is loaded.
        const commands = (await claude.supportedCommands()).map(command => command.name);
        expect(commands).toContain('factory:factory-plan');
        // Claude Code connects its MCP servers after it starts; Factory's in-process server answers
        // its handshake and tool listing over the exec's stdio.
        await vi.waitFor(
          async () =>
            expect(await claude.mcpServerStatus()).toEqual([
              expect.objectContaining({
                name: 'factory',
                status: 'connected',
                tools: [expect.objectContaining({ name: 'factory_probe' })],
              }),
            ]),
          { timeout: 30_000, interval: 250 },
        );

        // Its environment arrived over stdin (the fake exec gives it only PATH): it keeps its config in
        // the home Factory chose.
        expect((await stat(join(home, '.claude'))).isDirectory()).toBe(true);
        // It ran as one Sprite exec: the environment preamble, then the launch check, then the binary
        // (verified against its release checksum); no environment in the exec request.
        expect(raw.requests).toHaveLength(1);
        const [request] = raw.requests;
        expect(request).toMatchObject({ command: '/bin/sh', options: { cwd } });
        expect(request!.args.slice(2, 4)).toEqual(['/bin/sh', '-c']);
        expect(request!.args[4]).toContain(launch.pathToClaudeCodeExecutable);
        expect(request!.options).not.toHaveProperty('env');
        expect(execUrl(request!)).not.toContain(MARKER);
      } finally {
        release();
        claude.close();
      }
    });
  },
);
