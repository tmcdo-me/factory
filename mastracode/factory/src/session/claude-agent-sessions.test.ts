// fork(claude-agent)
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { answerParkedCall } from '../tools/approval-tools.js';
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
      expect(await ended).toEqual({ reason: 'complete' });

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
    expect(await board.ended).toEqual({ reason: 'awaiting_interaction' });
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
    expect(await ended).toEqual({ reason: 'complete' });
    expect(replies[0]).toMatch(/^Plan approved\./);
    expect(await store.listPending({ sessionId: 's1' })).toHaveLength(0);

    // Past what the board allows, the plan waits for a person: the run is parked, as a suspended
    // Mastra Code run ends, while Claude's turn stays open for the answer.
    const second = await runs.kickoff(
      's1',
      { runId: 'd2', prompt: 'Plan again.', autoApprovePlan: () => approvals++ < 1 },
      owner(),
    );
    expect(await second.ended).toEqual({ reason: 'awaiting_interaction' });
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
