// fork(claude-agent)
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import {
  InMemoryEventLog,
  InMemoryInteractionStore,
  InteractionBroker,
  SessionEventHub,
  defineFactoryTool,
} from '@factory/agent-runtime';
import type { FactoryToolContext, InteractionRecord, SessionCommands } from '@factory/agent-runtime';
import { ClaudeAgentSession } from '@factory/runtime-claude-agent';
import type { QueryFn } from '@factory/runtime-claude-agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { LocalSkillSource, Workspace } from '@mastra/core/workspace';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import { FACTORY_INTERACTIVE_KEY } from '../auth.js';
import { AgentMessagesStorage } from '../storage/domains/agent-messages/base.js';
import { InMemoryAgentMessages } from '../storage/domains/agent-messages/memory.js';
import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';
import { answerParkedCall, answerParkedQuestion } from '../tools/approval-tools.js';
import { FACTORY_SKILLS_MOUNT, FactorySkillSource } from '../workspace.js';
import { ClaudeAgentConcurrency } from './claude-agent-concurrency.js';
import {
  ClaudeAgentSessions,
  claudeAgentBackgroundMaxMs,
  claudeAgentBashSandbox,
  claudeAgentHome,
  claudeAgentHostSecretFiles,
  claudeAgentIdleCloseMs,
  lateAnswer,
  routeSessionCommands,
} from './claude-agent-sessions.js';
import type { ClaudeAgentSessionsDeps } from './claude-agent-sessions.js';
import type { MastraTools } from './claude-agent-tools.js';
import { claudeAgentWaitingJudge } from './claude-agent-waiting-judge.js';
import { claudeAgentRequestContext } from './claude-agent-workspace.js';

const now = new Date(0);

function memoryStore(records: AgentSessionRecord[]) {
  const map = new Map(records.map(record => [record.sessionId, { ...record }]));
  return {
    get: async (id: string) => map.get(id),
    setRuntimeState: vi.fn(async (id: string, state: unknown) => {
      map.get(id)!.runtimeState = state;
    }),
    setModel: vi.fn(async (id: string, modelId: string) => {
      map.get(id)!.modelId = modelId;
    }),
  };
}

/** A fake Claude Code: each user message gets an init (with a session id) and a successful result. */
function fakeQuery() {
  const options: Record<string, unknown>[] = [];
  const fn: QueryFn = ({ prompt, options: opts }) => {
    options.push(opts as Record<string, unknown>);
    const iterator = (async function* () {
      for await (const _message of prompt) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-xyz',
          model: 'claude-opus-5-5',
          uuid: 'u',
        } as never;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-xyz',
          uuid: 'u',
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      }
    })();
    return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
  };
  return { fn, options };
}

function setup(records: AgentSessionRecord[], home?: string) {
  const log = new InMemoryEventLog();
  const store = memoryStore(records);
  const fake = fakeQuery();
  const workspace = vi.fn(async (sessionId: string) => ({
    cwd: `/sandboxes/${sessionId}/repo`,
    env: { GH_TOKEN: 'ghs_x' },
  }));
  const sessions = new ClaudeAgentSessions({
    hub: new SessionEventHub(log),
    sessions: store,
    workspace,
    instructions: 'Factory instructions',
    hostEnv: { HOME: '/home/u', DATABASE_URL: 'postgres://secret' },
    query: fake.fn,
    ...(home ? { home } : {}),
  });
  return { sessions, store, fake, workspace, log };
}

const claude = (sessionId: string, extra: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  sessionId,
  runtimeId: 'claude-agent',
  createdAt: now,
  updatedAt: now,
  ...extra,
});

describe('ClaudeAgentSessions', () => {
  it('opens a Claude Agent session once, in its checkout, and stores its events', async () => {
    const { sessions, fake, workspace, log, store } = setup([claude('s1', { modelId: 'claude-sonnet-5-5' })]);
    const commands = sessions.commands();
    const request = { context: 'request-context' };

    expect(await commands.send('s1', { text: 'hi' }, request)).toEqual({ ok: true });
    expect(await commands.send('s1', { text: 'again' }, request)).toEqual({ ok: true });
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(2),
    );

    expect(workspace).toHaveBeenCalledTimes(1);
    expect(workspace).toHaveBeenCalledWith('s1', 'request-context', { bashSandbox: expect.any(Boolean) });
    expect(fake.options).toHaveLength(1);
    expect(fake.options[0]).toMatchObject({
      cwd: '/sandboxes/s1/repo',
      model: 'claude-sonnet-5-5',
      env: { HOME: '/home/u', GH_TOKEN: 'ghs_x' },
      // Factory's instructions first; with Claude's Bash sandboxed, how to push follows them.
      systemPrompt: { append: expect.stringMatching(/^Factory instructions(\n\n|$)/) },
    });
    expect(fake.options[0]!.env).not.toHaveProperty('DATABASE_URL');
    await vi.waitFor(() => expect(store.setRuntimeState).toHaveBeenCalledWith('s1', { claudeSessionId: 'claude-xyz' }));
    expect(store.setRuntimeState).toHaveBeenCalledTimes(1); // only when it changes
  });

  it("starts Claude Code with the sandbox's env as it is then, and stops it once idle", async () => {
    const log = new InMemoryEventLog();
    const fake = fakeQuery();
    let token = 0;
    const sessions = new ClaudeAgentSessions({
      hub: new SessionEventHub(log),
      sessions: memoryStore([claude('s1')]),
      workspace: async () => ({
        cwd: '/sandboxes/s1/repo',
        env: { GH_TOKEN: 'ghs_at_open' },
        freshEnv: async () => ({ GH_TOKEN: `ghs_fresh_${++token}` }),
      }),
      hostEnv: {},
      query: fake.fn,
      idleCloseMs: 20,
    });
    await sessions.commands().send('s1', { text: 'hi' }, { context: undefined });
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));
    expect(fake.options[0]!.env).toMatchObject({ GH_TOKEN: 'ghs_fresh_1' });
    // Idle past the timeout: the next turn starts a new Claude Code, resuming, with a fresh token.
    await new Promise(resolve => setTimeout(resolve, 60));
    await sessions.commands().send('s1', { text: 'again' }, { context: undefined });
    await vi.waitFor(() => expect(fake.options).toHaveLength(2));
    expect(fake.options[1]).toMatchObject({ env: { GH_TOKEN: 'ghs_fresh_2' }, resume: 'claude-xyz' });
  });

  // 9c: Claude's Bash commands (a repository's tests) must not get at Claude's credential.
  it("runs Claude's Bash in Claude Code's sandbox by default, unless FACTORY_CLAUDE_AGENT_BASH_SANDBOX=0", async () => {
    expect(claudeAgentBashSandbox({})).toBe(true);
    expect(claudeAgentBashSandbox({ FACTORY_CLAUDE_AGENT_BASH_SANDBOX: '1' })).toBe(true);
    for (const off of ['0', 'off', 'false', 'NO']) {
      expect(claudeAgentBashSandbox({ FACTORY_CLAUDE_AGENT_BASH_SANDBOX: off })).toBe(false);
    }
    const run = async (options: { bashSandbox?: boolean; posture?: 'trusted' | 'untrusted' }) => {
      const fake = fakeQuery();
      const opened: unknown[] = [];
      const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'claude-home-'));
      onTestFinished(() => rm(home, { recursive: true, force: true }));
      const sessions = new ClaudeAgentSessions({
        hub: new SessionEventHub(new InMemoryEventLog()),
        sessions: memoryStore([claude('s1')]),
        workspace: async (_id, _context, open) => {
          opened.push(open);
          return { cwd: '/sandboxes/s1/repo', env: {} };
        },
        home,
        hostEnv: { FACTORY_CLAUDE_AGENT_BASH_DENY_READ: '/etc/factory/claude.env' },
        query: fake.fn,
        ...(options.posture ? { checkout: async () => options.posture! } : {}),
        ...(options.bashSandbox !== undefined ? { bashSandbox: options.bashSandbox } : {}),
      });
      await sessions.commands().send('s1', { text: 'hi' }, { context: undefined });
      await vi.waitFor(() => expect(fake.options).toHaveLength(1));
      const sdk = fake.options[0] as {
        settings: { sandbox?: { credentials: { files: { path: string }[] } } };
        disallowedTools: string[];
      };
      return { sandbox: sdk.settings.sandbox, disallowedTools: sdk.disallowedTools, opened, home };
    };

    // On by default, on this host with its secret files denied and the cache directories made.
    const byDefault = await run({ bashSandbox: true });
    expect(byDefault.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
    });
    expect(byDefault.sandbox!.credentials.files.map(file => file.path)).toContain('/etc/factory/claude.env');
    expect(byDefault.opened).toEqual([{ bashSandbox: true }]);
    expect((await stat(join(byDefault.home, '.npm'))).isDirectory()).toBe(true);

    // Turned off, a trusted session runs without it; an untrusted checkout never does.
    const off = await run({ bashSandbox: false, posture: 'trusted' });
    expect(off.sandbox).toBeUndefined();
    expect(off.opened).toEqual([{ bashSandbox: false }]);
    // Claude's file tools run outside the Bash sandbox: sandboxed or not, they are refused the same files.
    for (const { sandbox, disallowedTools } of [byDefault, off]) {
      expect(disallowedTools).toEqual(
        expect.arrayContaining(['Read(//etc/factory/claude.env)', 'Edit(//etc/factory/claude.env)']),
      );
      for (const path of sandbox?.credentials.files.map(file => file.path) ?? []) {
        expect(disallowedTools).toContain(`Read(${path.startsWith('/') ? `/${path}` : path})`);
      }
    }
    const untrusted = await run({ bashSandbox: false, posture: 'untrusted' });
    expect(untrusted.sandbox).toMatchObject({ enabled: true });
    expect(untrusted.opened).toEqual([{ bashSandbox: true }]);
  });

  it("denies the commands the server's env files, wherever the server runs from", async () => {
    // `mastracode/web/.mastra/output/index.mjs`, started from `mastracode/web/src/mastra/public`.
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'factory-install-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const web = join(root, 'mastracode', 'web');
    await mkdir(join(web, '.mastra', 'output'), { recursive: true });
    await mkdir(join(web, 'src', 'mastra', 'public'), { recursive: true });
    for (const name of ['.env', '.env.local', '.env.schema', 'env.ts', '.envrc-not'])
      await writeFile(join(web, name), '');
    await writeFile(join(root, '.env'), '');
    const files = claudeAgentHostSecretFiles(
      { FACTORY_CLAUDE_AGENT_BASH_DENY_READ: ' /srv/secrets/claude.env ,relative/.env' },
      [join(web, '.mastra', 'output'), join(web, 'src', 'mastra', 'public')],
    );
    expect(files).toEqual(
      expect.arrayContaining([
        join(web, '.env'),
        join(web, '.env.local'),
        join(web, '.env.schema'),
        join(root, '.env'),
        '/srv/secrets/claude.env',
        join(homedir(), '.claude', '.credentials.json'),
      ]),
    );
    expect(files).not.toContain(join(web, 'env.ts'));
    expect(files).not.toContain(join(web, '.envrc-not'));
    expect(files.some(file => file.includes('relative'))).toBe(false);
    expect(new Set(files).size).toBe(files.length);
  });

  it('caps background work at FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS, and at the token deadline', async () => {
    expect(claudeAgentBackgroundMaxMs({})).toBe(3_600_000);
    expect(claudeAgentBackgroundMaxMs({ FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS: '900000' })).toBe(900_000);
    expect(claudeAgentBackgroundMaxMs({ FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS: '0' })).toBe(3_600_000);
    expect(claudeAgentBackgroundMaxMs({ FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS: 'never' })).toBe(3_600_000);
  });

  it('reads the idle timeout from FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS', () => {
    expect(claudeAgentIdleCloseMs({})).toBe(600_000);
    expect(claudeAgentIdleCloseMs({ FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS: '120000' })).toBe(120_000);
    expect(claudeAgentIdleCloseMs({ FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS: '0' })).toBe(0);
    expect(claudeAgentIdleCloseMs({ FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS: 'soon' })).toBe(600_000);
  });

  it("runs Claude Code in a home of its own, created on first use (private to the server's user)", async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-home-'));
    const home = join(root, 'claude-agent-home');
    try {
      const { sessions, fake, log } = setup([claude('s1')], home);
      await sessions.commands().send('s1', { text: 'hi' }, { context: undefined });
      await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));
      expect(fake.options[0]!.env).toMatchObject({
        HOME: home,
        CLAUDE_CONFIG_DIR: `${home}/.claude`,
        GH_TOKEN: 'ghs_x',
      });
      expect((await stat(home)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('puts that home under the server user, unless FACTORY_CLAUDE_AGENT_HOME says otherwise', () => {
    expect(claudeAgentHome({})).toMatch(/\.mastracode\/web\/claude-agent-home$/);
    expect(claudeAgentHome({ FACTORY_CLAUDE_AGENT_HOME: ' /srv/claude ' })).toBe('/srv/claude');
  });

  it('resumes the stored Claude session after a restart', async () => {
    const { sessions, fake } = setup([claude('s1', { runtimeState: { claudeSessionId: 'claude-old' } })]);
    await sessions.commands().send('s1', { text: 'hi' }, { context: undefined });
    await vi.waitFor(() => expect(fake.options).toHaveLength(1));
    expect(fake.options[0]).toMatchObject({ resume: 'claude-old' });
  });

  it('reports sessions on another runtime as not found, and retries a failed workspace', async () => {
    const { sessions, workspace } = setup([
      claude('s1'),
      { sessionId: 'm1', runtimeId: 'mastra-code', createdAt: now, updatedAt: now },
    ]);
    expect(await sessions.commands().abort('m1', { context: undefined })).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
    expect(await sessions.commands().abort('nope', { context: undefined })).toEqual({
      ok: false,
      reason: 'session_not_found',
    });

    workspace.mockRejectedValueOnce(new Error('clone failed'));
    await expect(sessions.commands().send('s1', { text: 'x' }, { context: undefined })).rejects.toThrow('clone failed');
    expect(await sessions.commands().send('s1', { text: 'x' }, { context: undefined })).toEqual({ ok: true });
  });

  it('switches the model live and records it', async () => {
    const { sessions, store } = setup([claude('s1')]);
    expect(await sessions.commands().setModel('s1', { modelId: 'claude-haiku-5-5' }, { context: undefined })).toEqual({
      ok: true,
    });
    expect(store.setModel).toHaveBeenCalledWith('s1', 'claude-haiku-5-5');
  });
});

/** Talks to the session's `factory` MCP server as Claude Code does. The MCP SDK comes with the Agent SDK. */
async function mcpClient(server: McpSdkServerConfigWithInstance) {
  const runtime = createRequire(import.meta.url).resolve('@factory/runtime-claude-agent/package.json');
  const sdk = createRequire(createRequire(runtime).resolve('@anthropic-ai/claude-agent-sdk'));
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = sdk('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(clientSide);
  return {
    list: async (): Promise<string[]> => (await client.listTools()).tools.map((tool: { name: string }) => tool.name),
    listTools: async (): Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]> =>
      (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>, toolUseId: string) =>
      (await client.callTool({ name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } })) as {
        isError?: boolean;
        content: { text: string }[];
      },
  };
}

/**
 * A fake Claude Code that runs `turn` for each user message while the turn is open (so tool calls
 * land in it), then ends the turn.
 */
function toolCallingQuery(turn: (server: Awaited<ReturnType<typeof mcpClient>>, index: number) => Promise<void>) {
  const options: Record<string, unknown>[] = [];
  const seen: unknown[] = [];
  const clients: ReturnType<typeof mcpClient>[] = [];
  const fn: QueryFn = ({ prompt, options: opts }) => {
    options.push(opts as Record<string, unknown>);
    const servers = (opts as { mcpServers?: Record<string, McpSdkServerConfigWithInstance> }).mcpServers;
    const client = servers?.factory ? mcpClient(servers.factory) : undefined;
    if (client) clients.push(client);
    const iterator = (async function* () {
      let index = 0;
      for await (const message of prompt) {
        seen.push(message);
        yield { type: 'system', subtype: 'init', session_id: 'claude-xyz', uuid: 'u' } as never;
        if (client) await turn(await client, index++);
        yield { type: 'result', subtype: 'success', session_id: 'claude-xyz', uuid: 'u', usage: {} } as never;
      }
    })();
    return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
  };
  return { fn, options, seen, clients };
}

function hostContext(userId: string, interactive = true) {
  const context = new RequestContext();
  context.set('user', { workosId: userId, organizationId: 'org-1' });
  if (interactive) context.set(FACTORY_INTERACTIVE_KEY, true);
  return context;
}

function toolSetup(query: QueryFn, extra: Partial<ClaudeAgentSessionsDeps> = {}) {
  const log = new InMemoryEventLog();
  const hub = new SessionEventHub(log);
  const store = new InMemoryInteractionStore();
  const broker = new InteractionBroker({ store, hub });
  const seen: Record<string, unknown>[] = [];
  const probe = createTool({
    id: 'factory_probe',
    description: 'Reports what a Factory tool sees',
    inputSchema: z.object({ item: z.string() }),
    execute: async ({ item }, execution) => {
      const rc = execution.requestContext!;
      const controller = rc.get('controller') as { sessionId: string };
      const user = rc.get('user') as { workosId: string };
      const call = {
        item,
        sessionId: controller.sessionId,
        user: user.workosId,
        interactive: rc.get(FACTORY_INTERACTIVE_KEY) === true,
        toolCallId: execution.agent?.toolCallId,
      };
      seen.push(call);
      return call;
    },
  });
  const tools = vi.fn(async (): Promise<MastraTools> => ({ factory_probe: probe }));
  const contextFor = claudeAgentRequestContext('s1');
  const sessions = new ClaudeAgentSessions({
    hub,
    sessions: memoryStore([claude('s1')]),
    workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {}, requestContext: contextFor }),
    tools,
    interactions: broker,
    hostEnv: {},
    query,
    ...extra,
  });
  return { sessions, log, store, broker, tools, seen };
}

describe('ClaudeAgentSessions with Factory tools', () => {
  it("serves the session's Factory tools to Claude Code, each call acting as its turn's caller", async () => {
    const results: unknown[] = [];
    const fake = toolCallingQuery(async (client, index) => {
      results.push(
        JSON.parse((await client.call('factory_probe', { item: `w${index}` }, `toolu_${index}`)).content[0]!.text),
      );
    });
    const { sessions, log, tools, seen } = toolSetup(fake.fn);
    const commands = sessions.commands();

    await commands.send('s1', { text: 'one' }, { context: hostContext('user-a') });
    await commands.send('s1', { text: 'two' }, { context: hostContext('user-b', false) });
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(2),
    );

    expect(fake.options).toHaveLength(1);
    expect(Object.keys(fake.options[0]!.mcpServers as object)).toEqual(['factory']);
    const listed = await (await fake.clients[0]!).list();
    expect(listed.sort()).toEqual(['ask_user', 'factory_probe', 'submit_plan']);

    // Each call ran in this session as the caller of its own turn, with Claude's tool_use id.
    expect(seen).toEqual([
      { item: 'w0', sessionId: 's1', user: 'user-a', interactive: true, toolCallId: 'toolu_0' },
      { item: 'w1', sessionId: 's1', user: 'user-b', interactive: false, toolCallId: 'toolu_1' },
    ]);
    expect(results).toEqual(seen);
    // Built once to list them, then once per turn, from that turn's request context.
    expect(tools).toHaveBeenCalledTimes(3);
    const contexts = tools.mock.calls.map(call => (call as unknown as [RequestContext])[0]);
    expect(contexts.map(rc => (rc.get('controller') as { sessionId: string }).sessionId)).toEqual(['s1', 's1', 's1']);
    expect(contexts.map(rc => (rc.get('user') as { workosId: string }).workosId)).toEqual([
      'user-a',
      'user-a',
      'user-b',
    ]);
  });

  // fork(claude-agent): slice 4, Factory's tool definitions reach Claude Code as they are.
  it('runs a Factory tool definition directly, with the call context Factory binds, and observes it', async () => {
    const calls: { input: unknown; ctx: FactoryToolContext }[] = [];
    const inspect = defineFactoryTool({
      name: 'factory_inspect_work_item',
      description: 'Inspect a card',
      input: z.object({ workItem: z.string().trim().min(1) }).strict(),
      execute: async (input, ctx) => {
        calls.push({ input, ctx });
        return { item: input.workItem };
      },
    });
    const replies: { isError?: boolean; content: { text: string }[] }[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(await client.call('factory_inspect_work_item', { workItem: '  #7 ' }, 'toolu_def'));
      replies.push(await client.call('factory_inspect_work_item', { workItem: 7 }, 'toolu_bad'));
    });
    const onToolResult = vi.fn(async () => {});
    const { sessions, log } = toolSetup(fake.fn, {
      onToolResult,
      tools: async () => ({ factory_inspect_work_item: inspect }),
    });
    await sessions.commands().send('s1', { text: 'look' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));

    const listed = await (await fake.clients[0]!).listTools();
    expect(listed.find(tool => tool.name === 'factory_inspect_work_item')).toMatchObject({
      description: 'Inspect a card',
      inputSchema: { properties: { workItem: { type: 'string', minLength: 1 } }, additionalProperties: false },
    });
    // The validated input, Claude's tool_use id, the turn's caller and the session's workspace.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ workItem: '#7' });
    expect(calls[0]!.ctx).toMatchObject({ sessionId: 's1', callId: 'toolu_def', orgId: 'org-1', userId: 'user-a' });
    expect(calls[0]!.ctx.workspace).toMatchObject({ kind: 'local', checkoutDir: '/sandboxes/s1/repo' });
    expect(JSON.parse(replies[0]!.content[0]!.text)).toEqual({ item: '#7' });
    // A rejected input never reaches the definition.
    expect(replies[1]!.isError).toBe(true);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]![0]).toMatchObject({
      callId: 'toolu_def',
      toolName: 'factory_inspect_work_item',
      status: 'success',
      value: { item: '#7' },
    });
  });

  // fork(claude-agent): slice 4.
  it("checks a definition's input against the turn's own copy, and observes a rejected one as an error", async () => {
    const execute = vi.fn(async () => 'moved');
    const lenient = defineFactoryTool({
      name: 'factory_move',
      description: 'Move',
      input: z.object({ stage: z.string() }),
      execute,
    });
    const strict = defineFactoryTool({ ...lenient, input: z.object({ stage: z.enum(['review']) }), execute });
    const replies: { isError?: boolean; content: { text: string }[] }[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(await client.call('factory_move', { stage: 'done' }, 'toolu_move'));
    });
    const onToolResult = vi.fn(async () => {});
    // Listed from the opening build; the turn's own build has the stricter schema.
    const tools = vi.fn().mockResolvedValueOnce({ factory_move: lenient }).mockResolvedValue({ factory_move: strict });
    const { sessions, log } = toolSetup(fake.fn, { onToolResult, tools });
    await sessions.commands().send('s1', { text: 'move' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));

    expect(execute).not.toHaveBeenCalled();
    expect(replies[0]!.isError).toBe(true);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]![0]).toMatchObject({ callId: 'toolu_move', status: 'error' });
  });

  it("asks ask_user's question through Factory and answers it from the session's interactions route", async () => {
    const replies: { isError?: boolean; content: { text: string }[] }[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(
        await client.call(
          'ask_user',
          { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] },
          'toolu_ask',
        ),
      );
    });
    const { sessions, log, store } = toolSetup(fake.fn);
    const commands = sessions.commands();
    const request = { context: hostContext('user-a') };
    await commands.send('s1', { text: 'decide' }, request);

    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));
    const [pending] = await store.listPending({ sessionId: 's1' });
    expect(pending).toMatchObject({
      callId: 'toolu_ask',
      request: { kind: 'question', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
    expect(
      await commands.answer('s1', { callId: 'toolu_ask' }, { kind: 'plan_approval', action: 'approved' }, request),
    ).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(
      await commands.answer('s1', { callId: 'toolu_other' }, { kind: 'question', answer: 'Yes' }, request),
    ).toMatchObject({
      ok: false,
      reason: 'not_pending',
    });
    expect(await commands.answer('s1', { callId: 'toolu_ask' }, { kind: 'question', answer: 'Yes' }, request)).toEqual({
      ok: true,
    });

    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(1),
    );
    expect(replies).toEqual([{ content: [{ type: 'text', text: 'User answered: Yes' }] }]);
    const types = (await log.list('s1')).map(e => e.event.type);
    expect(types).toContain('interaction.requested');
    expect(types).toContain('interaction.resolved');
    expect(await store.get(pending!.id)).toMatchObject({ status: 'resolved', resolvedBy: 'user-a' });
  });

  it('drops a waiting question when the turn is aborted', async () => {
    const replies: { isError?: boolean; content: { text: string }[] }[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(await client.call('ask_user', { question: 'Ship it?' }, 'toolu_ask'));
    });
    const { sessions, store } = toolSetup(fake.fn);
    const request = { context: hostContext('user-a') };
    await sessions.commands().send('s1', { text: 'decide' }, request);
    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));

    expect(await sessions.commands().abort('s1', request)).toEqual({ ok: true });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('cancelled') }] });
    expect(await store.listPending({ sessionId: 's1' })).toEqual([]);
  });

  it('delivers an answer nobody waits for any more (a restart) to the conversation as a message', async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, store, log } = toolSetup(fake.fn);
    const record: InteractionRecord = {
      id: 'int-1',
      sessionId: 's1',
      callId: 'toolu_old',
      request: { kind: 'plan_approval', planPath: '.artifacts/plans/a.md' },
      requestedAt: new Date(0).toISOString(),
      status: 'pending',
    };
    await store.create(record);

    const answer = { kind: 'plan_approval', action: 'approved' } as const;
    expect(
      await sessions.commands().answer('s1', { interactionId: 'int-1' }, answer, { context: hostContext('user-a') }),
    ).toEqual({
      ok: true,
    });
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(1),
    );
    expect(fake.seen).toMatchObject([{ message: { content: lateAnswer(record, answer) } }]);
    expect(lateAnswer(record, answer)).toContain('was approved');
  });

  it('has no Factory tools without a tool source, and no ask_user or submit_plan without a broker', async () => {
    const bare = toolCallingQuery(async () => {});
    const { sessions } = toolSetup(bare.fn, { tools: undefined });
    await sessions.commands().send('s1', { text: 'x' }, { context: hostContext('user-a') });
    await vi.waitFor(() => expect(bare.options).toHaveLength(1));
    expect(bare.options[0]).not.toHaveProperty('mcpServers');

    const noBroker = toolCallingQuery(async () => {});
    const { sessions: other } = toolSetup(noBroker.fn, { interactions: undefined });
    await other.commands().send('s1', { text: 'x' }, { context: hostContext('user-a') });
    await vi.waitFor(() => expect(noBroker.options).toHaveLength(1));
    expect(await (await noBroker.clients[0]!).list()).toEqual(['factory_probe']);
  });

  it("gives Claude Code the session's Factory skills as a plugin, and only those", async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-home-'));
    try {
      const source = new FactorySkillSource(new LocalSkillSource({ basePath: '/' }), [], undefined, async () => false);
      const skills = new Workspace({ skillSource: source, skills: [FACTORY_SKILLS_MOUNT] }).skills;
      const fake = toolCallingQuery(async () => {});
      const { sessions } = toolSetup(fake.fn, {
        home,
        workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {}, ...(skills ? { skills } : {}) }),
      });
      await sessions.commands().send('s1', { text: 'plan' }, { context: hostContext('user-a') });
      await vi.waitFor(() => expect(fake.options).toHaveLength(1));

      const plugin = join(home, 'factory-skills', 's1');
      expect(fake.options[0]).toMatchObject({
        plugins: [{ type: 'local', path: plugin, skipMcpDiscovery: true }],
        settings: { disableBundledSkills: true },
      });
      expect((fake.options[0]!.skills as string[]).sort()).toEqual([
        'factory:configure-factory-rules',
        'factory:factory-build',
        'factory:factory-plan',
        'factory:factory-triage',
      ]);
      expect(fake.options[0]!.tools).toContain('Skill');
      expect(await readFile(join(plugin, 'skills', 'factory-plan', 'SKILL.md'), 'utf8')).toContain('# Factory Plan');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("runs Claude Code inside the session's sandbox when the workspace launches it there", async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-home-'));
    try {
      const hostHome = join(root, 'never-created');
      const source = new FactorySkillSource(new LocalSkillSource({ basePath: '/' }), [], undefined, async () => false);
      const skills = new Workspace({ skillSource: source, skills: [FACTORY_SKILLS_MOUNT] }).skills;
      const written = new Map<string, string>();
      const files = {
        mkdir: vi.fn(async () => {}),
        rm: vi.fn(async () => {}),
        writeFile: vi.fn(async (path: string, content: string | Uint8Array) => {
          written.set(path, String(content));
        }),
      };
      const spawn = vi.fn();
      const spriteHome = '/home/sprite/.factory/claude-agent';
      const fake = toolCallingQuery(async () => {});
      const { sessions } = toolSetup(fake.fn, {
        home: hostHome,
        // After a Factory restart: the conversation's transcript is on the Sprite's disk.
        sessions: memoryStore([claude('s1', { runtimeState: { claudeSessionId: 'claude-prev' } })]),
        hostEnv: { HOME: '/home/u', PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' },
        workspace: async () => ({
          cwd: '/home/sprite/repo',
          env: { GH_TOKEN: 'ghs_x' },
          requestContext: claudeAgentRequestContext('s1'),
          ...(skills ? { skills } : {}),
          launch: {
            home: spriteHome,
            remote: true,
            files,
            spawnClaudeCodeProcess: spawn,
            pathToClaudeCodeExecutable: `${spriteHome}/.local/bin/claude`,
          },
        }),
      });
      await sessions.commands().send('s1', { text: 'plan' }, { context: hostContext('user-a') });
      await vi.waitFor(() => expect(fake.options).toHaveLength(1));

      const plugin = `${spriteHome}/factory-skills/s1`;
      expect(fake.options[0]).toMatchObject({
        cwd: '/home/sprite/repo',
        resume: 'claude-prev',
        spawnClaudeCodeProcess: spawn,
        pathToClaudeCodeExecutable: `${spriteHome}/.local/bin/claude`,
        plugins: [{ type: 'local', path: plugin, skipMcpDiscovery: true }],
        settingSources: ['project'],
        strictMcpConfig: true,
      });
      // Nothing of this host's environment, only Claude's credential and the sandbox's.
      expect(fake.options[0]!.env).toEqual({
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
        GH_TOKEN: 'ghs_x',
        HOME: spriteHome,
        CLAUDE_CONFIG_DIR: `${spriteHome}/.claude`,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'factory',
        // Push config for git in Claude's sandboxed shell, which can't write `.git/config`.
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'push.default',
        GIT_CONFIG_VALUE_0: 'current',
        GIT_CONFIG_KEY_1: 'branch.autoSetupMerge',
        GIT_CONFIG_VALUE_1: 'false',
      });
      // The skills plugin is written in the sandbox; nothing is written on this host.
      expect(written.get(`${plugin}/skills/factory-plan/SKILL.md`)).toContain('# Factory Plan');
      await expect(stat(hostHome)).rejects.toThrow();
      // Factory's in-process MCP server is served to it as for a local Claude Code.
      expect(Object.keys(fake.options[0]!.mcpServers as object)).toEqual(['factory']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never uses an unsafe session id as the skills folder it deletes and rewrites', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-home-'));
    try {
      await writeFile(join(home, 'keep.txt'), 'operator data');
      const source = new FactorySkillSource(new LocalSkillSource({ basePath: '/' }), [], undefined, async () => false);
      const skills = new Workspace({ skillSource: source, skills: [FACTORY_SKILLS_MOUNT] }).skills;
      const fake = toolCallingQuery(async () => {});
      const { sessions } = toolSetup(fake.fn, {
        home,
        sessions: memoryStore([claude('..')]),
        workspace: async () => ({ cwd: '/sandboxes/x/repo', env: {}, ...(skills ? { skills } : {}) }),
      });
      await expect(
        sessions.commands().send('..', { text: 'plan' }, { context: hostContext('user-a') }),
      ).rejects.toThrow(/not a safe folder name/);
      expect(fake.options).toHaveLength(0); // Claude Code never started
      expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('operator data'); // `<home>/factory-skills/..` was not wiped
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ClaudeAgentSessions board runs', () => {
  const owner = () => hostContext('user-a', false);
  const planSkills = () =>
    new Workspace({
      skillSource: new FactorySkillSource(new LocalSkillSource({ basePath: '/' }), [], undefined, async () => false),
      skills: [FACTORY_SKILLS_MOUNT],
    }).skills!;
  const userText = (message: unknown) => (message as { message: { content: string } }).message.content;

  it("kicks a phase's skill off in a freshly started Claude Code, under the run id the dispatcher chose", async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-home-'));
    try {
      const fake = toolCallingQuery(async () => {});
      const skills = planSkills();
      const { sessions, log } = toolSetup(fake.fn, {
        home,
        workspace: async () => ({
          cwd: '/sandboxes/s1/repo',
          env: {},
          skills,
          requestContext: claudeAgentRequestContext('s1'),
        }),
      });
      const runs = sessions.runtimeSessions();
      expect(await runs.runs('s1')).toBe(true);
      expect(await runs.runs('mastra-session')).toBe(false);

      // A person's turn first: Claude Code starts once for it.
      await sessions.commands().send('s1', { text: 'look around' }, { context: hostContext('user-a') });
      await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));
      expect(fake.options).toHaveLength(1);

      const { ended } = await runs.kickoff(
        's1',
        {
          runId: 'decision-1',
          skill: { name: 'factory-plan', arguments: 'card 42' },
          description: 'Make it faster',
          preface: 'The card moved to Planning.',
        },
        owner(),
      );
      // With the run's usage, for its run record.
      expect(await ended).toEqual({
        reason: 'complete',
        usage: [{ inputTokens: 0, outputTokens: 0 }],
      });

      // The kickoff started Claude Code again (its phase decides its tools and skills), resuming the conversation.
      expect(fake.options).toHaveLength(2);
      expect(fake.options[1]).toMatchObject({ resume: 'claude-xyz' });
      const kickoff = userText(fake.seen[1]);
      expect(kickoff).toContain(
        '<factory-message source="stage-transition">\nThe card moved to Planning.\n</factory-message>',
      );
      expect(kickoff).toContain('<skill name="factory-plan">\nRun the `factory:factory-plan` skill now');
      expect(kickoff).toContain('ARGUMENTS: card 42');
      // The card's description is data, and arrives escaped with the rest of the kickoff.
      expect(kickoff).toContain('&lt;work-item-description&gt;');
      expect(await runs.hasRun('s1', 'decision-1')).toBe(true);
      expect(await runs.hasRun('s1', 'decision-2')).toBe(false);
      const events = (await log.list('s1')).map(e => e.event);
      expect(events).toContainEqual(expect.objectContaining({ type: 'run.started', runId: 'decision-1' }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'notice',
          kind: 'reactive',
          tag: 'skill',
          attributes: { name: 'factory-plan' },
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("tells a goal's kickoff its objective, and goes on with its re-kicks in the same Claude Code", async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, log } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();

    await (
      await runs.kickoff(
        's1',
        { runId: 'd1', prompt: 'Build it.', goal: { objective: 'Ship it.', maxRuns: 20 } },
        owner(),
      )
    ).ended;
    expect(userText(fake.seen[0])).toContain('<goal type="goal" maxRuns="20">\nShip it.\n</goal>');

    await (
      await runs.kickoff('s1', { runId: 'd1:goal:1', continuation: '[Goal attempt 1/20] Not yet.' }, owner())
    ).ended;
    // No restart: the phase, and so its tools and skills, are the same.
    expect(fake.options).toHaveLength(1);
    expect(userText(fake.seen[1])).toBe('<goal-judge type="goal-judge">\n[Goal attempt 1/20] Not yet.\n</goal-judge>');
    await vi.waitFor(async () =>
      expect((await log.list('s1')).map(e => e.event)).toContainEqual(
        expect.objectContaining({ type: 'notice', kind: 'system-reminder', tag: 'goal-judge', runId: 'd1:goal:1' }),
      ),
    );
    // Factory's reminder, not a person's words.
    const events = (await log.list('s1')).map(e => e.event);
    expect(
      events.filter(event => event.type === 'message.started' && event.role === 'user' && event.runId === 'd1:goal:1'),
    ).toEqual([]);
  });

  it('tells whoever waits on a parked board run how it ends once the person answers', async () => {
    const fake = toolCallingQuery(async client => {
      await client.call('ask_user', { question: 'Which database?' }, 'toolu_q');
    });
    const { sessions, store } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();

    const parked = await (await runs.kickoff('s1', { runId: 'd1', prompt: 'Build it.' }, owner())).ended;
    expect(parked.reason).toBe('awaiting_interaction');
    const [pending] = await store.listPending({ sessionId: 's1' });
    await sessions
      .commands()
      .answer(
        's1',
        { interactionId: pending!.id },
        { kind: 'question', answer: 'Postgres' },
        { context: hostContext('user-a') },
      );
    expect(await parked.resumed).toMatchObject({ reason: 'complete' });
  });

  it("refuses a skill the session doesn't have, before anything reaches Claude", async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions } = toolSetup(fake.fn);
    await expect(
      sessions.runtimeSessions().kickoff('s1', { runId: 'd1', skill: { name: 'factory-plan' } }, owner()),
    ).rejects.toMatchObject({ code: 'run_configuration_invalid' });
    expect(fake.seen).toHaveLength(0);
  });

  it('knows only the runs this process started: a run never outlives its Claude Code', async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, log } = toolSetup(fake.fn);
    // Before a restart the kickoff landed; its Claude Code died with that process, so it is owed again.
    await log.append('s1', [{ type: 'run.started', runId: 'decision-1' }]);
    const runs = sessions.runtimeSessions();
    expect(await runs.hasRun('s1', 'decision-1')).toBe(false);
    const { ended } = await runs.kickoff('s1', { runId: 'decision-1', prompt: 'Go.' }, owner());
    await ended;
    expect(await runs.hasRun('s1', 'decision-1')).toBe(true);
  });

  it('resumes the conversation across a restart even before its resume state is stored', async () => {
    const fake = toolCallingQuery(async () => {});
    const store = memoryStore([claude('s1')]);
    // Saving the resume state is fire-and-forget; here it never lands.
    store.setRuntimeState.mockImplementation(() => new Promise<void>(() => {}));
    const { sessions } = toolSetup(fake.fn, { sessions: store });
    const runs = sessions.runtimeSessions();
    await (
      await runs.kickoff('s1', { runId: 'd1', prompt: 'One.' }, owner())
    ).ended;
    await (
      await runs.kickoff('s1', { runId: 'd2', prompt: 'Two.' }, owner())
    ).ended;
    expect(fake.options).toHaveLength(2);
    expect(fake.options[0]).not.toHaveProperty('resume');
    expect(fake.options[1]).toMatchObject({ resume: 'claude-xyz' });
  });

  it('records an untrusted checkout without putting back a resume id Claude replaced meanwhile', async () => {
    // Claude Code answers only the first turn, once released; later turns stay in flight.
    let release!: () => void;
    const released = new Promise<void>(resolve => (release = resolve));
    let turns = 0;
    const query: QueryFn = ({ prompt }) =>
      Object.assign(
        (async function* () {
          for await (const _message of prompt) {
            if (turns++ > 0) await new Promise(() => {});
            yield { type: 'system', subtype: 'init', session_id: 'claude-new', model: 'm', uuid: 'u' } as never;
            await released;
            yield {
              type: 'result',
              subtype: 'success',
              session_id: 'claude-new',
              uuid: 'u',
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 1 },
            } as never;
          }
        })(),
        { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() },
      ) as never;
    const stored = memoryStore([claude('s1', { runtimeState: { claudeSessionId: 'claude-old' } })]);
    // A copy per read, as a database returns rows.
    const store = { ...stored, get: async (id: string) => structuredClone(await stored.get(id)) };
    // Trusted when it opens; the next turn's check is slow, and finds the checkout untrusted.
    let untrusted!: () => void;
    const checkout = vi
      .fn<() => Promise<'trusted' | 'untrusted'>>()
      .mockResolvedValueOnce('trusted')
      .mockImplementationOnce(() => new Promise(resolve => (untrusted = () => resolve('untrusted'))));
    const sessions = new ClaudeAgentSessions({
      hub: new SessionEventHub(new InMemoryEventLog()),
      sessions: store,
      workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {} }),
      checkout,
      query,
    });
    const commands = sessions.commands();
    await commands.send('s1', { text: 'one' }, { context: undefined });
    // The next turn reads the record (still `claude-old`) and waits on the posture check.
    const second = commands.send('s1', { text: 'two' }, { context: undefined }).catch(() => undefined);
    await vi.waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
    release();
    await vi.waitFor(async () =>
      expect((await store.get('s1'))?.runtimeState).toEqual({ claudeSessionId: 'claude-new' }),
    );

    untrusted();
    await second;
    // Before the next turn ends and rewrites it.
    await vi.waitFor(async () =>
      expect((await store.get('s1'))?.runtimeState).toEqual({ claudeSessionId: 'claude-new', untrustedCheckout: true }),
    );
  });

  it('stops the runs in flight when the server shuts down, saying so', async () => {
    // A turn that runs until Claude Code is closed; closing ends its process (a signal exit).
    const query: QueryFn = ({ prompt }) => {
      let kill!: () => void;
      const killed = new Promise<void>(resolve => (kill = resolve));
      return Object.assign(
        (async function* () {
          for await (const _message of prompt) {
            await killed;
            throw new Error('Claude Code process exited with code 143');
          }
        })(),
        { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn(() => kill()) },
      ) as never;
    };
    const log = new InMemoryEventLog();
    const sessions = new ClaudeAgentSessions({
      hub: new SessionEventHub(log),
      sessions: memoryStore([claude('s1')]),
      workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {} }),
      query,
    });
    await sessions.commands().send('s1', { text: 'one' }, { context: undefined });

    await sessions.shutdown();

    await vi.waitFor(async () => {
      const events = (await log.list('s1')).map(e => e.event);
      expect(events).toContainEqual(expect.objectContaining({ type: 'run.ended', reason: 'aborted' }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'notice',
          tag: 'run-stopped',
          text: expect.stringContaining('shut down or restarted'),
        }),
      );
      expect(events.some(event => event.type === 'error')).toBe(false);
    });
  });

  it('holds at most 20 waiting messages, and says how many it dropped', async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, log } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();
    for (let n = 1; n <= 25; n += 1) {
      await runs.message('s1', { text: `news ${n}`, source: 'source-activity', wake: false }, owner());
    }
    await runs.message('s1', { text: 'now', source: 'rule-message', wake: true }, owner());
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));

    const told = userText(fake.seen[0]);
    expect(told).toContain('5 earlier Factory messages were dropped');
    expect(told).not.toContain('news 5\n');
    expect(told).toContain('news 6');
    expect(told).toContain('news 25');
  });

  it('opens no Claude Code while another Factory process runs Claude Agent sessions', async () => {
    const fake = fakeQuery();
    const sessions = new ClaudeAgentSessions({
      hub: new SessionEventHub(new InMemoryEventLog()),
      sessions: memoryStore([claude('s1')]),
      workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {} }),
      host: { held: async () => false, onLost: () => {} },
      query: fake.fn,
    });
    await expect(sessions.commands().send('s1', { text: 'hi' }, { context: undefined })).rejects.toMatchObject({
      code: 'session_unavailable',
    });
    await expect(
      sessions.runtimeSessions().kickoff('s1', { runId: 'd1', prompt: 'Build it.' }, owner()),
    ).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(fake.options).toHaveLength(0);
  });

  it('stops its runs and opens no more once another Factory process takes Claude Agent over', async () => {
    // A turn that runs until Claude Code is closed; closing ends its process (a signal exit).
    const query: QueryFn = ({ prompt }) => {
      let kill!: () => void;
      const killed = new Promise<void>(resolve => (kill = resolve));
      return Object.assign(
        (async function* () {
          for await (const _message of prompt) {
            await killed;
            throw new Error('Claude Code process exited with code 143');
          }
        })(),
        { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn(() => kill()) },
      ) as never;
    };
    let holding = true;
    let lose!: () => void;
    const log = new InMemoryEventLog();
    const sessions = new ClaudeAgentSessions({
      hub: new SessionEventHub(log),
      sessions: memoryStore([claude('s1')]),
      workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {} }),
      host: { held: async () => holding, onLost: listener => (lose = listener) },
      query,
    });
    await sessions.commands().send('s1', { text: 'one' }, { context: undefined });

    holding = false;
    lose();

    await vi.waitFor(async () => {
      const events = (await log.list('s1')).map(e => e.event);
      expect(events).toContainEqual(expect.objectContaining({ type: 'run.ended', reason: 'aborted' }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'notice',
          tag: 'run-stopped',
          text: expect.stringContaining('another Factory process'),
        }),
      );
    });
    await expect(sessions.commands().send('s1', { text: 'two' }, { context: undefined })).rejects.toMatchObject({
      code: 'session_unavailable',
    });
  });

  it("says so when a session's runtime cannot be looked up, rather than guessing", async () => {
    const store = memoryStore([]);
    const { sessions } = toolSetup(toolCallingQuery(async () => {}).fn, {
      sessions: { ...store, get: async () => Promise.reject(new Error('db down')) },
    });
    await expect(sessions.runtimeSessions().runs('s1')).rejects.toThrow('db down');
  });

  it("tells a board run parked on its own plan from a person's turn waiting on their question", async () => {
    const fake = toolCallingQuery(async (client, index) => {
      if (index === 0) await client.call('ask_user', { question: 'Ship it?' }, 'toolu_person');
      else await client.call('submit_plan', { path: 'plan.md' }, 'toolu_board');
    });
    const { sessions, store } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();

    await sessions.commands().send('s1', { text: 'decide' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));
    expect(runs.isRunning('s1')).toBe(true);
    expect(await runs.parkedBoardRun('s1')).toBe(false);

    await runs.abort('s1', owner());
    await runs.idle('s1');
    const board = await runs.kickoff('s1', { runId: 'board-1', prompt: 'Plan it.' }, owner());
    expect(await board.ended).toEqual({ reason: 'awaiting_interaction', resumed: expect.any(Promise) });
    expect(await runs.parkedBoardRun('s1')).toBe(true);
  });

  it("tells the session Factory's messages: waking it with a turn, or with its next one", async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, log } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();

    await runs.message('s1', { text: 'Comment by @ann on #42', source: 'source-activity', wake: false }, owner());
    expect(fake.seen).toHaveLength(0);
    await runs.message('s1', { text: 'Rebase onto main.', source: 'rule-message', wake: true }, owner());
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));

    expect(userText(fake.seen[0])).toBe(
      '<factory-message source="source-activity">\nComment by @ann on #42\n</factory-message>\n\n' +
        '<factory-message source="rule-message">\nRebase onto main.\n</factory-message>',
    );
    // Factory's words, not the person's.
    const events = (await log.list('s1')).map(e => e.event);
    expect(events.some(e => e.type === 'message.started' && e.role === 'user')).toBe(false);
    expect(events.filter(e => e.type === 'notice').map(e => (e as { text: string }).text)).toEqual([
      'Comment by @ann on #42',
      'Rebase onto main.',
    ]);
  });

  it("tells each turn the card's context when it changed since the session last heard it", async () => {
    const fake = toolCallingQuery(async () => {});
    let revision = 1;
    const context = vi.fn(async (_rc: RequestContext, previous: ReadonlyMap<string, { cacheKey: string }>) => {
      const cacheKey = `rev-${revision}`;
      if (previous.get('factory-phase')?.cacheKey === cacheKey) return [];
      return [{ id: 'factory-phase', cacheKey, kind: 'state', tag: 'factory-phase', text: `Revision: ${revision}` }];
    });
    const { sessions, log } = toolSetup(fake.fn, { context });
    const commands = sessions.commands();
    const turns = async (count: number) =>
      vi.waitFor(async () =>
        expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(count),
      );

    await commands.send('s1', { text: 'one' }, { context: hostContext('user-a') });
    await turns(1);
    await commands.send('s1', { text: 'two' }, { context: hostContext('user-a') });
    await turns(2);
    revision = 2;
    await commands.send('s1', { text: 'three' }, { context: hostContext('user-a') });
    await turns(3);

    expect(fake.seen.map(userText)).toEqual([
      '<factory-phase>\nRevision: 1\n</factory-phase>\n\none',
      'two',
      '<factory-phase>\nRevision: 2\n</factory-phase>\n\nthree',
    ]);
    // It reads the card as the session's tools do: through the session's controller context.
    const rc = context.mock.calls[0]![0];
    expect((rc.get('controller') as { sessionId: string }).sessionId).toBe('s1');
    // The person's words stay theirs; the context is a notice beside them.
    const users = (await log.list('s1')).filter(e => e.event.type === 'message.delta').map(e => e.event);
    expect(users.map(e => (e as { delta: string }).delta)).toEqual(['one', 'two', 'three']);
  });

  it("approves a board run's plan on the board's behalf while the dispatcher says so", async () => {
    const replies: string[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(
        (await client.call('submit_plan', { path: 'plan.md' }, `toolu_plan_${replies.length}`)).content[0]!.text,
      );
    });
    const { sessions, store } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();
    let approvals = 0;
    const { ended } = await runs.kickoff(
      's1',
      { runId: 'd1', prompt: 'Plan it.', autoApprovePlan: () => approvals++ < 1 },
      owner(),
    );
    expect(await ended).toMatchObject({ reason: 'complete' });
    expect(replies[0]).toMatch(/^Plan approved\./);
    expect(await store.listPending({ sessionId: 's1' })).toHaveLength(0);

    // Past what the board allows, the plan waits for a person: the run is parked, as a suspended
    // Mastra Code run ends, while Claude's turn stays open for the answer.
    const second = await runs.kickoff(
      's1',
      { runId: 'd2', prompt: 'Plan again.', autoApprovePlan: () => approvals++ < 1 },
      owner(),
    );
    expect(await second.ended).toEqual({ reason: 'awaiting_interaction', resumed: expect.any(Promise) });
    expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1);
    expect(await runs.awaitsPerson('s1')).toBe(true);
    expect(runs.isRunning('s1')).toBe(true);
  });

  it("never approves a person's own plan, even one queued behind a board run that may approve its own", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const replies: string[] = [];
    const fake = toolCallingQuery(async (client, index) => {
      if (index === 0) return gate; // the board's run
      replies.push((await client.call('submit_plan', { path: 'plan.md' }, 'toolu_person')).content[0]!.text);
    });
    const { sessions, store } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();
    const board = await runs.kickoff(
      's1',
      { runId: 'board-1', prompt: 'Plan it.', autoApprovePlan: () => true },
      owner(),
    );
    await sessions.commands().send('s1', { text: 'here is my plan' }, { context: hostContext('user-a') });
    release();
    await board.ended;

    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));
    expect(replies).toEqual([]);
  });

  it('waits for the run in flight before saying the session is idle', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fake = toolCallingQuery(async () => gate);
    const { sessions } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();
    await expect(runs.idle('s1')).resolves.toBeUndefined();
    await runs.message('s1', { text: 'go', source: 'rule-message', wake: true }, owner());
    await vi.waitFor(() => expect(runs.isRunning('s1')).toBe(true));
    let idle = false;
    void runs.idle('s1').then(() => {
      idle = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(idle).toBe(false);
    release();
    await vi.waitFor(() => expect(idle).toBe(true));
  });
});

describe('ClaudeAgentSessions tool observers', () => {
  it("tells Factory each tool call's result before Claude gets it, failures included", async () => {
    const order: string[] = [];
    const echo = createTool({
      id: 'factory_echo',
      description: 'Echoes',
      inputSchema: z.object({ item: z.string() }),
      execute: async ({ item }) => ({ item }),
    });
    const failing = createTool({
      id: 'factory_fail',
      description: 'Always fails',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('no such card');
      },
    });
    const fake = toolCallingQuery(async client => {
      await client.call('factory_echo', { item: 'w1' }, 'toolu_ok');
      order.push('claude got the result');
      await client.call('factory_fail', {}, 'toolu_bad');
    });
    const onToolResult = vi.fn(async (result: { toolName: string }) => {
      order.push(`observed ${result.toolName}`);
    });
    const { sessions, log } = toolSetup(fake.fn, {
      onToolResult,
      tools: async () => ({ factory_echo: echo, factory_fail: failing }),
    });
    await sessions.commands().send('s1', { text: 'go' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));

    expect(order).toEqual(['observed factory_echo', 'claude got the result', 'observed factory_fail']);
    expect(onToolResult.mock.calls[0]![0]).toMatchObject({
      sessionId: 's1',
      callId: 'toolu_ok',
      toolName: 'factory_echo',
      input: { item: 'w1' },
      status: 'success',
      value: { item: 'w1' },
    });
    expect(onToolResult.mock.calls[1]![0]).toMatchObject({ callId: 'toolu_bad', status: 'error' });
    // It carries the request context the call ran with: the session's, as the turn's caller.
    const rc = (onToolResult.mock.calls[0]![0] as unknown as { requestContext: RequestContext }).requestContext;
    expect((rc.get('controller') as { sessionId: string }).sessionId).toBe('s1');
    expect((rc.get('user') as { workosId: string }).workosId).toBe('user-a');
  });

  it("follows Claude Code's own shell commands and reports each one that finished", async () => {
    const onShellResult = vi.fn(async () => {});
    const query: QueryFn = ({ prompt }) => {
      const iterator = (async function* () {
        for await (const _message of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'claude-xyz', uuid: 'u' } as never;
          yield {
            type: 'assistant',
            uuid: 'u',
            session_id: 'claude-xyz',
            parent_tool_use_id: null,
            message: {
              id: 'msg_1',
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_gh', name: 'Bash', input: { command: 'gh pr create --fill' } }],
            },
          } as never;
          yield {
            type: 'user',
            uuid: 'u',
            session_id: 'claude-xyz',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gh', content: 'ok' }] },
            tool_use_result: { stdout: 'https://github.com/acme/repo/pull/7\n', stderr: '' },
          } as never;
          yield { type: 'result', subtype: 'success', session_id: 'claude-xyz', uuid: 'u', usage: {} } as never;
        }
      })();
      return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
    };
    const { sessions } = toolSetup(query, { onShellResult });
    await sessions.commands().send('s1', { text: 'open the PR' }, { context: hostContext('user-a') });

    await vi.waitFor(() => expect(onShellResult).toHaveBeenCalledTimes(1));
    const [shell] = onShellResult.mock.calls[0] as unknown as [
      { command: string; output: string; requestContext: RequestContext },
    ];
    expect(shell).toMatchObject({
      sessionId: 's1',
      callId: 'toolu_gh',
      command: 'gh pr create --fill',
      output: 'https://github.com/acme/repo/pull/7\n',
    });
    expect((shell.requestContext.get('user') as { workosId: string }).workosId).toBe('user-a');
  });
});

describe('routeSessionCommands', () => {
  it('sends commands to the runtime recorded for the session, else the fallback', async () => {
    const calls: string[] = [];
    const fake = (name: string): SessionCommands => ({
      send: async id => (calls.push(`${name}:send:${id}`), { ok: true }),
      abort: async id => (calls.push(`${name}:abort:${id}`), { ok: true }),
      answer: async id => (calls.push(`${name}:answer:${id}`), { ok: true }),
      setModel: async id => (calls.push(`${name}:model:${id}`), { ok: true }),
    });
    const router = routeSessionCommands({
      sessions: memoryStore([claude('c1')]),
      runtimes: { 'claude-agent': fake('claude') },
      fallback: fake('mastra'),
    });
    const request = { context: undefined };
    await router.send('c1', { text: 'x' }, request);
    await router.send('m1', { text: 'x' }, request);
    await router.answer('c1', { callId: 'x' }, { kind: 'question', answer: 'y' }, request);
    await router.setModel('m1', { modelId: 'm' }, request);
    expect(calls).toEqual(['claude:send:c1', 'mastra:send:m1', 'claude:answer:c1', 'mastra:model:m1']);
  });

  it("refuses, rather than guessing, when the session's runtime can't be read", async () => {
    const calls: string[] = [];
    const fake: SessionCommands = {
      send: async id => (calls.push(`send:${id}`), { ok: true }),
      abort: async id => (calls.push(`abort:${id}`), { ok: true }),
      answer: async id => (calls.push(`answer:${id}`), { ok: true }),
      setModel: async id => (calls.push(`model:${id}`), { ok: true }),
    };
    const router = routeSessionCommands({
      sessions: { get: async () => Promise.reject(new Error('db down')) },
      runtimes: { 'claude-agent': fake },
      fallback: fake,
    });
    expect(await router.send('c1', { text: 'x' }, { context: undefined })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(calls).toEqual([]);
  });
});

describe('ClaudeAgentSessions approvals from outside the session', () => {
  const owner = () => hostContext('user-a', false);

  function planning() {
    const replies: { isError?: boolean; content: { text: string }[] }[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(await client.call('ask_user', { question: 'Which database?' }, 'toolu_ask'));
      replies.push(await client.call('submit_plan', { path: 'plan.md' }, 'toolu_plan'));
    });
    return { fake, replies, ...toolSetup(fake.fn) };
  }

  it('lists only the calls a yes or no answers, and answers one as the session owner, recording who decided', async () => {
    const { sessions, store, replies } = planning();
    const runs = sessions.runtimeSessions();
    await sessions.commands().send('s1', { text: 'plan it' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));

    // A question needs a typed answer, as Mastra Code's ask_user does: none is listed.
    expect(await runs.approvals!.waiting('s1')).toEqual([]);
    const [asked] = await store.listPending({ sessionId: 's1' });
    await sessions.commands().answer(
      's1',
      { callId: 'toolu_ask' },
      { kind: 'question', answer: 'Postgres' },
      {
        context: hostContext('user-a'),
      },
    );
    await vi.waitFor(async () => expect(await runs.approvals!.waiting('s1')).toHaveLength(1));
    expect(await runs.approvals!.waiting('s1')).toEqual([{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }]);
    expect(await store.get(asked!.id)).toMatchObject({ status: 'resolved' });
    const [plan] = await store.listPending({ sessionId: 's1' });

    expect(await runs.approvals!.answer('s1', 'toolu_ask', { decision: 'approve' }, owner())).toBe('not_pending');
    expect(
      await runs.approvals!.answer(
        's1',
        'toolu_plan',
        { decision: 'decline', reason: 'Split it in two.', answeredBy: 'user-b' },
        owner(),
      ),
    ).toBe('answered');
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.content[0]!.text).toContain('Split it in two.');
    expect(await store.get(plan!.id)).toMatchObject({
      status: 'resolved',
      resolvedBy: 'user-b',
      response: { kind: 'plan_approval', action: 'rejected', feedback: 'Split it in two.' },
    });
    expect(await runs.approvals!.answer('s1', 'toolu_plan', { decision: 'approve' }, owner())).toBe('not_pending');
  });

  it("answers through factory_answer_approval's path without touching the controller, and Claude carries on", async () => {
    const { sessions, store, replies } = planning();
    await sessions.commands().send('s1', { text: 'plan it' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));
    await sessions.commands().answer(
      's1',
      { callId: 'toolu_ask' },
      { kind: 'question', answer: 'Postgres' },
      {
        context: hostContext('user-a'),
      },
    );
    await vi.waitFor(async () => expect(await sessions.runtimeSessions().approvals!.waiting('s1')).toHaveLength(1));

    const getSession = vi.fn(async () => null);
    await expect(
      answerParkedCall(
        { messaging: async () => ({ controller: { getSession }, runtime: sessions.runtimeSessions() }) as never },
        {
          session: { sessionId: 's1', userId: 'user-a', orgId: 'org-1' },
          decision: 'approve',
          declineReason: 'No.',
          answeredBy: 'user-b',
        },
      ),
    ).resolves.toEqual({ toolCallId: 'toolu_plan', toolName: 'submit_plan' });

    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.isError).toBeFalsy();
    expect(getSession).not.toHaveBeenCalled();
    expect(await store.listPending({ sessionId: 's1' })).toEqual([]);
  });

  it('answers a stale click without starting Claude Code or its workspace', async () => {
    const fake = toolCallingQuery(async () => {});
    const workspace = vi.fn(async () => ({ cwd: '/sandboxes/s1/repo', env: {} }));
    const { sessions } = toolSetup(fake.fn, { workspace });
    expect(
      await sessions.runtimeSessions().approvals!.answer('s1', 'toolu_gone', { decision: 'approve' }, owner()),
    ).toBe('not_pending');
    expect(workspace).not.toHaveBeenCalled();
    expect(fake.options).toHaveLength(0);
  });

  it('delivers an approval nobody waits for any more (a restart) to the conversation as a message', async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, store, log } = toolSetup(fake.fn);
    const record: InteractionRecord = {
      id: 'int-1',
      sessionId: 's1',
      callId: 'toolu_old',
      request: { kind: 'plan_approval', planPath: '.artifacts/plans/a.md' },
      requestedAt: new Date(0).toISOString(),
      status: 'pending',
    };
    await store.create(record);
    const runs = sessions.runtimeSessions();

    expect(await runs.approvals!.waiting('s1')).toEqual([{ toolCallId: 'toolu_old', toolName: 'submit_plan' }]);
    expect(
      await runs.approvals!.answer('s1', 'toolu_old', { decision: 'approve', answeredBy: 'user-b' }, owner()),
    ).toBe('answered');
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(1),
    );
    expect(fake.seen).toMatchObject([
      { message: { content: lateAnswer(record, { kind: 'plan_approval', action: 'approved' }) } },
    ]);
    expect(await store.get('int-1')).toMatchObject({ status: 'resolved', resolvedBy: 'user-b' });
  });
});

describe('ClaudeAgentSessions questions answered from outside the session', () => {
  const owner = () => hostContext('user-a', false);

  function asking() {
    const replies: { isError?: boolean; content: { text: string }[] }[] = [];
    const fake = toolCallingQuery(async client => {
      replies.push(
        await client.call(
          'ask_user',
          { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
          'toolu_ask',
        ),
      );
      replies.push(await client.call('submit_plan', { path: 'plan.md' }, 'toolu_plan'));
    });
    return { fake, replies, ...toolSetup(fake.fn) };
  }

  const answer = (sessions: ClaudeAgentSessions, reply: string | string[], toolCallId?: string) => {
    const getSession = vi.fn(async () => null);
    return {
      getSession,
      answered: answerParkedQuestion(
        { messaging: async () => ({ controller: { getSession }, runtime: sessions.runtimeSessions() }) as never },
        {
          session: { sessionId: 's1', userId: 'user-a', orgId: 'org-1' },
          ...(toolCallId ? { toolCallId } : {}),
          answer: reply,
          answeredBy: 'user-b',
        },
      ),
    };
  };

  it("answers the question through factory_answer_question's path, recording who answered, and Claude carries on with it", async () => {
    const { sessions, store, replies } = asking();
    await sessions.commands().send('s1', { text: 'plan it' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));
    const runs = sessions.runtimeSessions();
    expect(await runs.questions!.waiting('s1')).toEqual([
      {
        toolCallId: 'toolu_ask',
        interactionId: expect.any(String),
        toolName: 'ask_user',
        request: expect.objectContaining({ kind: 'question' }),
      },
    ]);
    // A question is not a yes or no: the approval path doesn't list it.
    expect(await runs.approvals!.waiting('s1')).toEqual([]);
    const [asked] = await store.listPending({ sessionId: 's1' });

    const { getSession, answered } = answer(sessions, 'Postgres');
    await expect(answered).resolves.toEqual({
      toolCallId: 'toolu_ask',
      interactionId: asked!.id,
      toolName: 'ask_user',
    });

    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]!.isError).toBeFalsy();
    expect(replies[0]!.content[0]!.text).toContain('Postgres');
    expect(getSession).not.toHaveBeenCalled();
    expect(await store.get(asked!.id)).toMatchObject({
      status: 'resolved',
      resolvedBy: 'user-b',
      response: { kind: 'question', answer: 'Postgres' },
    });
    // The plan that follows is still the approval path's, and no question waits any more.
    await vi.waitFor(async () => expect(await runs.approvals!.waiting('s1')).toHaveLength(1));
    expect(await runs.questions!.waiting('s1')).toEqual([]);
    await expect(answer(sessions, 'Yes').answered).rejects.toThrow(
      'This session is not waiting on a question. Open it to see what it needs.',
    );
  });

  it('refuses a second answer to a question already answered', async () => {
    const { sessions, store } = asking();
    await sessions.commands().send('s1', { text: 'plan it' }, { context: hostContext('user-a') });
    await vi.waitFor(async () => expect(await store.listPending({ sessionId: 's1' })).toHaveLength(1));

    const results = await Promise.allSettled([
      answer(sessions, 'Postgres', 'toolu_ask').answered,
      answer(sessions, 'SQLite', 'toolu_ask').answered,
    ]);

    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('delivers an answer nobody waits for any more (a restart) to the conversation as a message', async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, store, log } = toolSetup(fake.fn);
    const record: InteractionRecord = {
      id: 'int-q',
      sessionId: 's1',
      callId: 'toolu_old_ask',
      request: { kind: 'question', question: 'Which database?' },
      requestedAt: new Date(0).toISOString(),
      status: 'pending',
    };
    await store.create(record);
    const runs = sessions.runtimeSessions();

    expect(
      await runs.questions!.answer(
        's1',
        { toolCallId: 'toolu_old_ask' },
        { answer: 'Postgres', answeredBy: 'user-b' },
        owner(),
      ),
    ).toBe('answered');
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(1),
    );
    expect(fake.seen).toMatchObject([
      { message: { content: lateAnswer(record, { kind: 'question', answer: 'Postgres' }) } },
    ]);
    expect(await store.get('int-q')).toMatchObject({ status: 'resolved', resolvedBy: 'user-b' });
  });
});

describe('ClaudeAgentSessions messages that wait', () => {
  const owner = () => hostContext('user-a', false);
  const userText = (message: unknown) => (message as { message: { content: string } }).message.content;
  const fromSession = (id: string, wake: boolean) => ({
    text: 'Is the build green?',
    source: 'factory-session',
    wake,
    attributes: { kind: 'message', 'from-session': 'session-a' },
    delivery: { id, threadId: 's1', kind: 'message', priority: 'medium', sourceId: 'session-a' },
  });

  async function messageStore() {
    const storage = new LibSQLFactoryStorage({ id: 'claude-agent-messages', url: ':memory:' });
    const messages = storage.registerDomain(new AgentMessagesStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    return messages;
  }

  it("keeps a held message across a restart, and tells it with the session's next turn", async () => {
    const messages = await messageStore();
    const before = toolSetup(toolCallingQuery(async () => {}).fn, { messages });
    await before.sessions.runtimeSessions().message('s1', fromSession('note-1', false), owner());
    await before.sessions.shutdown();

    // A new process: nothing of the old one is left but the store.
    const fake = toolCallingQuery(async () => {});
    const after = toolSetup(fake.fn, { messages });
    await after.sessions.commands().send('s1', { text: 'Carry on.' }, { context: hostContext('user-a') });
    await vi.waitFor(async () =>
      expect((await after.log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true),
    );

    // Claude reads it under its id, so it can answer it.
    expect(userText(fake.seen[0])).toBe(
      '<factory-message kind="message" from-session="session-a" id="note-1" source="factory-session">\n' +
        'Is the build green?\n</factory-message>\n\nCarry on.',
    );
    expect(await messages.take('s1')).toEqual({ messages: [], dropped: 0 });
    expect(await after.sessions.runtimeSessions().deliveries!.get('s1', 'note-1')).toMatchObject({ status: 'told' });
  });

  it('keeps a message that woke the session, so the session can answer it', async () => {
    const fake = toolCallingQuery(async () => {});
    const { sessions, log } = toolSetup(fake.fn);
    const runs = sessions.runtimeSessions();
    const { runId } = await runs.message('s1', fromSession('note-2', true), owner());
    expect(runId).toEqual(expect.any(String));
    await vi.waitFor(async () => expect((await log.list('s1')).some(e => e.event.type === 'run.ended')).toBe(true));

    expect(userText(fake.seen[0])).toContain('id="note-2"');
    expect(await runs.deliveries!.get('s1', 'note-2')).toMatchObject({
      status: 'told',
      delivery: { threadId: 's1', kind: 'message', sourceId: 'session-a' },
    });
    expect((await runs.deliveries!.recentOnThread('s1', 10)).map(record => record.id)).toEqual(['note-2']);
    expect(await runs.deliveries!.get('s2', 'note-2')).toBeUndefined();
  });

  it("says so when a message can't be kept, rather than claiming it waits", async () => {
    const messages = new InMemoryAgentMessages();
    vi.spyOn(messages, 'hold').mockRejectedValue(new Error('db down'));
    const { sessions } = toolSetup(toolCallingQuery(async () => {}).fn, { messages });
    await expect(sessions.runtimeSessions().message('s1', fromSession('note-3', false), owner())).rejects.toThrow(
      'db down',
    );
  });

  it("sends no message it couldn't keep, and forgets one whose turn never started", async () => {
    const messages = new InMemoryAgentMessages();
    const fake = toolCallingQuery(async () => {});
    const { sessions } = toolSetup(fake.fn, { messages });
    const runs = sessions.runtimeSessions();
    const told = vi.spyOn(messages, 'told').mockRejectedValueOnce(new Error('db down'));
    await expect(runs.message('s1', fromSession('note-5', true), owner())).rejects.toThrow('db down');
    expect(fake.seen).toHaveLength(0);
    told.mockRestore();

    const send = vi.spyOn(ClaudeAgentSession.prototype, 'send').mockRejectedValueOnce(new Error('closed'));
    await expect(runs.message('s1', fromSession('note-6', true), owner())).rejects.toThrow('closed');
    expect(await runs.deliveries!.get('s1', 'note-6')).toBeUndefined();
    send.mockRestore();
  });

  it('says whether what waits survives a restart', async () => {
    const memory = toolSetup(toolCallingQuery(async () => {}).fn);
    expect(memory.sessions.runtimeSessions().deliveries!.durable).toBe(false);
    const stored = toolSetup(toolCallingQuery(async () => {}).fn, { messages: await messageStore() });
    expect(stored.sessions.runtimeSessions().deliveries!.durable).toBe(true);
  });

  it("still takes its turn when the waiting messages can't be read, and tells them later", async () => {
    const messages = new InMemoryAgentMessages();
    const fake = toolCallingQuery(async () => {});
    const { sessions, log } = toolSetup(fake.fn, { messages });
    const runs = sessions.runtimeSessions();
    await runs.message('s1', fromSession('note-4', false), owner());
    const take = vi.spyOn(messages, 'take').mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sessions.commands().send('s1', { text: 'one' }, { context: hostContext('user-a') });
    await sessions.commands().send('s1', { text: 'two' }, { context: hostContext('user-a') });
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(2),
    );

    expect(userText(fake.seen[0])).toBe('one');
    expect(userText(fake.seen[1])).toContain('id="note-4"');
    expect(take).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

// fork(claude-agent): a board run whose turn ends asking the person something in plain text.
describe('ClaudeAgentSessions: a turn that ends asking the person in plain text', () => {
  /** Claude Code answering each turn with the next of `replies` as its last message. */
  function replyingQuery(replies: string[]) {
    const seen: string[] = [];
    const fn: QueryFn = ({ prompt }) => {
      const iterator = (async function* () {
        let turn = 0;
        for await (const message of prompt) {
          seen.push(String((message as { message: { content: unknown } }).message.content));
          const text = replies[turn] ?? 'Done.';
          turn += 1;
          yield { type: 'system', subtype: 'init', session_id: 'claude-q', uuid: 'u' } as never;
          yield {
            type: 'assistant',
            session_id: 'claude-q',
            uuid: 'u',
            parent_tool_use_id: null,
            message: { id: `msg-${turn}`, role: 'assistant', content: [{ type: 'text', text }] },
          } as never;
          yield { type: 'result', subtype: 'success', session_id: 'claude-q', uuid: 'u', usage: {} } as never;
        }
      })();
      return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
    };
    return { fn, seen };
  }

  function questionSetup(replies: string[], verdict = { waiting: true as const, question: 'Staging or production?' }) {
    const log = new InMemoryEventLog();
    const hub = new SessionEventHub(log);
    const store = new InMemoryInteractionStore();
    const broker = new InteractionBroker({ store, hub });
    const fake = replyingQuery(replies);
    // The judge is Claude Code itself (`judgeWaitingOnPerson`); here, what it would decide.
    const waitingJudge = vi.fn(async () => verdict);
    const sessions = new ClaudeAgentSessions({
      hub,
      sessions: memoryStore([claude('s1')]),
      workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {} }),
      query: fake.fn,
      interactions: broker,
      waitingJudge,
    });
    onTestFinished(() => sessions.shutdown());
    return { sessions, broker, store, fake, waitingJudge, runs: sessions.runtimeSessions() };
  }

  const owner = () => hostContext('user-a', false);
  const goal = { objective: 'Import the CSV into the right database.' };

  it('parks the run on the question, in the inbox like ask_user, and follows the answer given there', async () => {
    const { sessions, broker, fake, waitingJudge, runs } = questionSetup([
      'I found two databases.\n\nWhich one should the importer write to: staging or production?',
      'Imported into staging.',
    ]);
    const { ended } = await runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner());
    expect(await ended).toMatchObject({ reason: 'complete' });

    expect(await runs.askedPerson!('s1', goal)).toBe('Staging or production?');
    expect(waitingJudge).toHaveBeenCalledWith({
      objective: goal.objective,
      text: 'I found two databases.\n\nWhich one should the importer write to: staging or production?',
    });
    const parked = await runs.awaitReply!('s1', { question: 'Staging or production?' }, owner());
    const [pending] = await broker.listPending({ sessionId: 's1' });
    expect(pending?.request).toEqual({ kind: 'question', question: 'Staging or production?' });
    expect(await runs.awaitsPerson('s1')).toBe(true);

    expect(
      await sessions
        .commands()
        .answer('s1', { interactionId: pending!.id }, { kind: 'question', answer: 'Staging' }, { context: owner() }),
    ).toEqual({ ok: true });
    // The answer is the person's reply in the session; the run follows its turn.
    expect(await parked!.resumed).toMatchObject({ reason: 'complete' });
    expect(fake.seen.at(-1)).toBe('Staging');
    expect(await broker.listPending({ sessionId: 's1' })).toEqual([]);
  });

  it("answers the question from outside the session through factory_answer_question's path, named by its interaction", async () => {
    const { broker, store, fake, runs } = questionSetup([
      'Which one should the importer write to: staging or production?',
      'Imported into production.',
    ]);
    await (
      await runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner())
    ).ended;
    const parked = await runs.awaitReply!('s1', { question: 'Staging or production?' }, owner());
    const [pending] = await broker.listPending({ sessionId: 's1' });
    // No tool call asked it: only its interaction names it.
    expect(await runs.questions!.waiting('s1')).toEqual([
      {
        interactionId: pending!.id,
        toolName: 'ask_user',
        request: { kind: 'question', question: 'Staging or production?' },
      },
    ]);

    const getSession = vi.fn(async () => null);
    await expect(
      answerParkedQuestion(
        { messaging: async () => ({ controller: { getSession }, runtime: runs }) as never },
        {
          session: { sessionId: 's1', userId: 'user-a', orgId: 'org-1' },
          interactionId: pending!.id,
          answer: 'production',
          answeredBy: 'user-b',
        },
      ),
    ).resolves.toEqual({ interactionId: pending!.id, toolName: 'ask_user' });

    expect(await parked!.resumed).toMatchObject({ reason: 'complete' });
    expect(fake.seen.at(-1)).toBe('production');
    expect(getSession).not.toHaveBeenCalled();
    expect(await store.get(pending!.id)).toMatchObject({ status: 'resolved', resolvedBy: 'user-b' });
  });

  it('takes a message the person types in the session as the reply, and drops the question', async () => {
    const { sessions, broker, fake, runs } = questionSetup(['Should the importer write to staging or production?']);
    await (
      await runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner())
    ).ended;
    const parked = await runs.awaitReply!('s1', { question: 'Staging or production?' }, owner());
    expect(await broker.listPending({ sessionId: 's1' })).toHaveLength(1);

    await sessions.commands().send('s1', { text: 'production, carefully' }, { context: hostContext('user-a') });
    expect(await parked!.resumed).toMatchObject({ reason: 'complete' });
    expect(fake.seen.at(-1)).toBe('production, carefully');
    await vi.waitFor(async () => expect(await broker.listPending({ sessionId: 's1' })).toEqual([]));
  });

  it('asks no judge about a turn that asked nothing, and none when it can go on by itself', async () => {
    const done = questionSetup(['Imported everything; the tests pass.']);
    await (
      await done.runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner())
    ).ended;
    expect(await done.runs.askedPerson!('s1', goal)).toBeUndefined();
    expect(done.waitingJudge).not.toHaveBeenCalled();

    const permission = questionSetup(['Half of it is in. Shall I continue with the rest?'], {
      waiting: false,
    } as never);
    await (
      await permission.runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner())
    ).ended;
    expect(await permission.runs.askedPerson!('s1', goal)).toBeUndefined();
    expect(permission.waitingJudge).toHaveBeenCalledTimes(1);
  });

  it('ends the parked run as aborted, and withdraws the question, when this process stops running sessions', async () => {
    const { sessions, broker, runs } = questionSetup(['Staging or production?']);
    await (
      await runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner())
    ).ended;
    const parked = await runs.awaitReply!('s1', { question: 'Staging or production?' }, owner());
    await sessions.shutdown();
    expect(await parked!.resumed).toEqual({ reason: 'aborted' });
    await vi.waitFor(async () => expect(await broker.listPending({ sessionId: 's1' })).toEqual([]));
  });

  it("ends the parked run as aborted when the card's next kickoff comes first", async () => {
    const { broker, runs } = questionSetup(['Staging or production?']);
    await (
      await runs.kickoff('s1', { runId: 'd1', prompt: 'Import it.' }, owner())
    ).ended;
    const parked = await runs.awaitReply!('s1', { question: 'Staging or production?' }, owner());
    await runs.kickoff('s1', { runId: 'd2', prompt: 'Review it.' }, owner());
    expect(await parked!.resumed).toEqual({ reason: 'aborted' });
    await vi.waitFor(async () => expect(await broker.listPending({ sessionId: 's1' })).toEqual([]));
  });
});

// fork(claude-agent)
describe('claudeAgentWaitingJudge', () => {
  it('runs the installed claude the host names, and logs only its first failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-judge-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const options: Record<string, unknown>[] = [];
    const query: QueryFn = ({ options: opts }) => {
      options.push(opts as Record<string, unknown>);
      const iterator = (async function* () {
        yield { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', uuid: 'u' } as never;
      })();
      return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
    };
    const log = vi.fn();
    const judge = claudeAgentWaitingJudge({
      home,
      hostEnv: { HOME: '/home/u', FACTORY_CLAUDE_AGENT_EXECUTABLE: '/opt/claude/bin/claude', DATABASE_URL: 'secret' },
      query,
      log,
    });
    expect(await judge({ objective: 'x', text: 'y?' })).toBeUndefined();
    expect(await judge({ objective: 'x', text: 'y?' })).toBeUndefined();
    expect(options[0]).toMatchObject({
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      cwd: join(home, 'goal-judge'),
    });
    expect(options[0]!.env).not.toHaveProperty('DATABASE_URL');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs a failure again once the judge had decided in between', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-judge-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const answers = ['Not logged in', '{"decision":"continue"}', 'Not logged in'];
    const query: QueryFn = () => {
      const answer = answers.shift()!;
      const iterator = (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: answer.startsWith('Not'),
          result: answer,
          uuid: 'u',
        } as never;
      })();
      return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
    };
    const log = vi.fn();
    const judge = claudeAgentWaitingJudge({ home, hostEnv: { HOME: '/home/u' }, query, log });
    for (let i = 0; i < 3; i++) await judge({ objective: 'x', text: 'y?' });
    expect(log).toHaveBeenCalledTimes(2);
  });
});

// fork(claude-agent): the operator's cap on Claude Agent turns at once (spec slice 13).
describe('ClaudeAgentSessions under a concurrency cap', () => {
  /** A Claude Code whose turns stay open until the test finishes them, per session. */
  function heldQuery() {
    const finish = new Map<string, Array<() => void>>();
    const started: string[] = [];
    const fn: QueryFn = ({ prompt, options }) => {
      const cwd = String((options as { cwd?: string }).cwd);
      const iterator = (async function* () {
        for await (const _message of prompt) {
          started.push(cwd);
          yield { type: 'system', subtype: 'init', session_id: `claude-${cwd}`, uuid: 'u' } as never;
          await new Promise<void>(resolve => finish.set(cwd, [...(finish.get(cwd) ?? []), resolve]));
          yield { type: 'result', subtype: 'success', session_id: 'c', uuid: 'u', usage: {} } as never;
        }
      })();
      // Closing ends whatever turn it is in, as stopping Claude Code does.
      const close = () => {
        for (const resolve of finish.get(cwd)?.splice(0) ?? []) resolve();
      };
      return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close }) as never;
    };
    return {
      fn,
      started,
      finish: (sessionId: string) => finish.get(`/sandboxes/${sessionId}/repo`)?.shift()?.(),
    };
  }

  function capSetup(cap: string) {
    const log = new InMemoryEventLog();
    const fake = heldQuery();
    const concurrency = new ClaudeAgentConcurrency({ env: { FACTORY_CLAUDE_AGENT_MAX_CONCURRENT: cap } });
    const sessions = new ClaudeAgentSessions({
      hub: new SessionEventHub(log),
      sessions: memoryStore([claude('busy'), claude('board'), claude('chat')]),
      workspace: async sessionId => ({ cwd: `/sandboxes/${sessionId}/repo`, env: {} }),
      query: fake.fn,
      turns: concurrency.limiter,
    });
    onTestFinished(() => sessions.shutdown());
    // Stored as the session publishes them, so read once they landed.
    const queuedNotices = async (sessionId: string) => {
      let found: Awaited<ReturnType<typeof log.list>> = [];
      await vi.waitFor(async () => {
        found = (await log.list(sessionId)).filter(e => e.event.type === 'notice' && e.event.tag === 'turn-queued');
        expect(found.length).toBeGreaterThan(0);
      });
      return found;
    };
    return { log, fake, concurrency, sessions, queuedNotices };
  }

  const owner = () => hostContext('user-a', false);

  it('lets a board run wait its turn behind a running session, never failing it, and starts it once a slot frees', async () => {
    const { fake, concurrency, sessions, queuedNotices } = capSetup('1');
    await sessions.commands().send('busy', { text: 'a long task' }, { context: hostContext('user-a') });
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));

    // The kickoff is accepted at once: the dispatcher watches the run while it waits.
    const runs = sessions.runtimeSessions();
    const { ended } = await runs.kickoff('board', { runId: 'decision-1', prompt: 'Build it.' }, owner());
    expect(runs.isRunning('board')).toBe(true);
    expect(await queuedNotices('board')).toHaveLength(1);
    expect(concurrency.limiter.snapshot().waiting).toMatchObject([{ sessionId: 'board', priority: 'factory' }]);
    expect(fake.started).toEqual(['/sandboxes/busy/repo']);

    fake.finish('busy');
    await vi.waitFor(() => expect(fake.started).toEqual(['/sandboxes/busy/repo', '/sandboxes/board/repo']));
    fake.finish('board');
    expect(await ended).toMatchObject({ reason: 'complete' });
    expect(concurrency.state()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('ends a board run still waiting for a slot as aborted when this process stops its sessions', async () => {
    const { fake, concurrency, sessions } = capSetup('1');
    await sessions.commands().send('busy', { text: 'a long task' }, { context: hostContext('user-a') });
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    const { ended } = await sessions
      .runtimeSessions()
      .kickoff('board', { runId: 'decision-1', prompt: 'Build it.' }, owner());
    await sessions.shutdown();
    expect(await ended).toMatchObject({ reason: 'aborted' });
    expect(fake.started).toEqual(['/sandboxes/busy/repo']);
    expect(concurrency.state()).toMatchObject({ running: 0, waiting: 0 });
  });

  it("puts a person's message to an idle session ahead of a waiting board run, with a notice in their session", async () => {
    const { fake, concurrency, sessions, queuedNotices } = capSetup('1');
    await sessions.commands().send('busy', { text: 'a long task' }, { context: hostContext('user-a') });
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    await sessions.runtimeSessions().kickoff('board', { runId: 'decision-1', prompt: 'Build it.' }, owner());
    expect(
      await sessions.commands().send('chat', { text: 'quick question' }, { context: hostContext('user-a') }),
    ).toEqual({ ok: true });
    const [notice] = await queuedNotices('chat');
    expect(notice?.event).toMatchObject({ text: expect.stringContaining('This turn starts as soon as one ends') });
    expect(concurrency.limiter.snapshot().waiting.map(waiter => waiter.sessionId)).toEqual(['chat', 'board']);

    fake.finish('busy');
    await vi.waitFor(() => expect(fake.started.at(-1)).toBe('/sandboxes/chat/repo'));
    expect(fake.started).not.toContain('/sandboxes/board/repo');
  });
});

// fork(claude-agent): one GitHub event is one notification, whether it came by webhook or poll, or again.
describe('ClaudeAgentSessions: messages with a dedupe key', () => {
  it('tells the session about an event once, however often it is sent', async () => {
    const { sessions, log } = setup([claude('s1')]);
    const runs = sessions.runtimeSessions();
    const owner = hostContext('user-a', false);
    const review = {
      text: 'ada requested changes on #34.',
      source: 'github',
      wake: true,
      dedupeKey: 'github:github:99:pull-request:34:review:4242',
    };
    expect(await runs.message('s1', review, owner)).toMatchObject({ runId: expect.any(String) });
    expect(await runs.message('s1', review, owner)).toEqual({});
    // Held for the next turn: kept once too.
    const comment = { ...review, wake: false, dedupeKey: 'github:github:99:pull-request:34:comment:7' };
    await runs.message('s1', comment, owner);
    await runs.message('s1', comment, owner);
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(1),
    );
    await sessions.commands().send('s1', { text: 'next' }, { context: hostContext('user-a') });
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(2),
    );
    const told = (await log.list('s1')).filter(
      e => e.event.type === 'notice' && e.event.tag === 'factory-message' && e.event.text.includes('ada'),
    );
    expect(told).toHaveLength(2);
  });
});
