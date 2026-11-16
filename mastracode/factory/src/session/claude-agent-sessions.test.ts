// fork(claude-agent)
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { InMemoryEventLog, InMemoryInteractionStore, InteractionBroker, SessionEventHub } from '@factory/agent-runtime';
import type { InteractionRecord, SessionCommands } from '@factory/agent-runtime';
import type { QueryFn } from '@factory/runtime-claude-agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { LocalSkillSource, Workspace } from '@mastra/core/workspace';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FACTORY_INTERACTIVE_KEY } from '../auth.js';
import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';
import { FACTORY_SKILLS_MOUNT, FactorySkillSource } from '../workspace.js';
import { ClaudeAgentSessions, claudeAgentHome, lateAnswer, routeSessionCommands } from './claude-agent-sessions.js';
import type { ClaudeAgentSessionsDeps } from './claude-agent-sessions.js';
import type { MastraTools } from './claude-agent-tools.js';
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
    expect(workspace).toHaveBeenCalledWith('s1', 'request-context');
    expect(fake.options).toHaveLength(1);
    expect(fake.options[0]).toMatchObject({
      cwd: '/sandboxes/s1/repo',
      model: 'claude-sonnet-5-5',
      env: { HOME: '/home/u', GH_TOKEN: 'ghs_x' },
      systemPrompt: { append: 'Factory instructions' },
    });
    expect(fake.options[0]!.env).not.toHaveProperty('DATABASE_URL');
    await vi.waitFor(() => expect(store.setRuntimeState).toHaveBeenCalledWith('s1', { claudeSessionId: 'claude-xyz' }));
    expect(store.setRuntimeState).toHaveBeenCalledTimes(1); // only when it changes
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
});
