import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildTranscript } from '@factory/agent-runtime';
import type { EventEnvelope, FactoryEvent } from '@factory/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { claudeProcessEnv } from './env';
import { ClaudeAgentSession } from './session';
import type { QueryFn } from './session';

const base = { session_id: 'claude-1', uuid: '00000000-0000-0000-0000-000000000000' } as const;
const ev = (event: Record<string, unknown>, parent: string | null = null) =>
  ({ ...base, type: 'stream_event', parent_tool_use_id: parent, event }) as unknown as SDKMessage;
const assistant = (id: string, content: unknown[], parent: string | null = null) =>
  ({
    ...base,
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, role: 'assistant', content },
  }) as unknown as SDKMessage;
const toolResult = (callId: string, text: string, structured?: unknown, isError = false) =>
  ({
    ...base,
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: text, is_error: isError }],
    },
    ...(structured ? { tool_use_result: structured } : {}),
  }) as unknown as SDKMessage;
const result = (subtype: 'success' | 'error_during_execution' = 'success') =>
  ({
    ...base,
    type: 'result',
    subtype,
    total_cost_usd: 0.012,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900 },
    ...(subtype === 'success' ? { result: 'done' } : { errors: ['interrupted'] }),
  }) as unknown as SDKMessage;
const init = {
  ...base,
  type: 'system',
  subtype: 'init',
  model: 'claude-opus-5-5',
  cwd: '/w',
  tools: [],
} as unknown as SDKMessage;

/** One scripted turn: a streamed reply with thinking, text and a Bash call; a todo list; a subagent. */
const firstTurn: SDKMessage[] = [
  init,
  ev({ type: 'message_start', message: { id: 'msg_1' } }),
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the tests.' } }),
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Running ' } }),
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'them.' } }),
  ev({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} },
  }),
  ev({
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"command":"pnpm test"}' },
  }),
  ev({ type: 'content_block_stop', index: 2 }),
  ev({ type: 'message_stop' }),
  assistant('msg_1', [
    { type: 'thinking', thinking: 'Check the tests.' },
    { type: 'text', text: 'Running them.' },
    { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'pnpm test' } },
  ]),
  toolResult('toolu_bash', 'FAIL 1', { stdout: 'FAIL 1\n', stderr: 'warn\n' }),
  assistant('msg_2', [
    {
      type: 'tool_use',
      id: 'toolu_todo',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Fix test', status: 'in_progress', activeForm: 'Fixing test' }] },
    },
    {
      type: 'tool_use',
      id: 'toolu_task',
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Find the flake' },
    },
  ]),
  toolResult('toolu_todo', 'ok'),
  assistant(
    'msg_sub',
    [{ type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'flaky' } }],
    'toolu_task',
  ),
  toolResult('toolu_grep', 'a.test.ts'),
  toolResult('toolu_task', 'It is a.test.ts'),
  assistant('msg_3', [{ type: 'text', text: 'Fixed.' }]),
  result(),
];

/** A fake `query()`: answers each user message with the next scripted turn. */
function fakeQuery(turns: SDKMessage[][], seen: SDKUserMessage[] = []) {
  const calls: { options: unknown }[] = [];
  const control = { interrupt: vi.fn(async () => undefined), setModel: vi.fn(async () => {}), close: vi.fn() };
  const fn: QueryFn = ({ prompt, options }) => {
    calls.push({ options });
    const iterator = (async function* () {
      let turn = 0;
      for await (const message of prompt) {
        seen.push(message);
        for (const out of turns[turn++] ?? [result()]) yield out;
      }
    })();
    return Object.assign(iterator, control) as unknown as Query;
  };
  return { fn, calls, control, seen };
}

function setup(turns: SDKMessage[][] = [firstTurn]) {
  const events: FactoryEvent[] = [];
  const fake = fakeQuery(turns);
  let n = 0;
  const session = new ClaudeAgentSession({
    sessionId: 's1',
    cwd: '/work/s1',
    env: { HOME: '/home/u' },
    instructions: 'You are working on a Factory card.',
    emit: event => events.push(event),
    query: fake.fn,
    newId: () => `id-${++n}`,
  });
  const transcript = () =>
    buildTranscript(
      's1',
      events.map((event, index): EventEnvelope => ({ sessionId: 's1', seq: index + 1, at: 't', event })),
    );
  return { session, events, fake, transcript };
}

const settled = (events: FactoryEvent[], count = 1) =>
  vi.waitFor(() => expect(events.filter(e => e.type === 'run.ended')).toHaveLength(count));

describe('ClaudeAgentSession', () => {
  it("runs a turn and folds Claude Code's stream into the transcript Factory draws", async () => {
    const { session, events, fake, transcript } = setup();
    await session.send({ text: 'Fix the flaky test' });
    await settled(events);

    expect(fake.seen[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'Fix the flaky test' } });
    const t = transcript();
    expect(
      t.items.map(item => [item.kind, 'name' in item ? item.name : item.kind === 'message' ? item.role : '']),
    ).toEqual([
      ['run', ''],
      ['message', 'user'],
      ['message', 'assistant'],
      ['tool', 'Bash'],
      // msg_2 carries only tool calls: an empty assistant turn the projection hangs them on.
      ['message', 'assistant'],
      ['tool', 'TodoWrite'],
      ['tool', 'Task'],
      ['subagent', ''],
      ['tool', 'Grep'],
      ['message', 'assistant'],
    ]);
    expect(t.items).toMatchObject([
      { kind: 'run', runId: 'id-1', status: 'complete' },
      { kind: 'message', role: 'user', parts: [{ type: 'text', text: 'Fix the flaky test' }] },
      {
        kind: 'message',
        messageId: 'msg_1',
        complete: true,
        parts: [
          { type: 'reasoning', text: 'Check the tests.' },
          { type: 'text', text: 'Running them.' },
        ],
      },
      {
        callId: 'toolu_bash',
        category: 'shell',
        executor: 'runtime',
        inputText: '{"command":"pnpm test"}',
        input: { command: 'pnpm test' },
        stdout: 'FAIL 1\n',
        stderr: 'warn\n',
        status: 'done',
      },
      { kind: 'message', messageId: 'msg_2', parts: [], complete: true },
      { callId: 'toolu_todo', status: 'done' },
      { callId: 'toolu_task', status: 'done' },
      {
        kind: 'subagent',
        callId: 'toolu_task',
        agentType: 'Explore',
        task: 'Find the flake',
        status: 'done',
        result: 'It is a.test.ts',
      },
      { callId: 'toolu_grep', category: 'search', parentCallId: 'toolu_task', status: 'done' },
      { kind: 'message', messageId: 'msg_3', parts: [{ type: 'text', text: 'Fixed.' }], complete: true },
    ]);
    expect(t.tasks).toEqual([{ id: '1', title: 'Fix test', status: 'in_progress', activeTitle: 'Fixing test' }]);
    expect(t.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 900, costUsd: 0.012 });
    expect(events).toContainEqual({ type: 'model.changed', runtimeId: 'claude-agent', modelId: 'claude-opus-5-5' });
    expect(session.runtimeState()).toEqual({ claudeSessionId: 'claude-1' });
  });

  it('starts Claude Code with Factory settings: own checkout, project settings only, preset prompt', async () => {
    const { session, events, fake } = setup();
    await session.send({ text: 'hi' });
    await settled(events);
    expect(fake.calls[0]!.options).toMatchObject({
      cwd: '/work/s1',
      env: { HOME: '/home/u' },
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are working on a Factory card.' },
      disallowedTools: ['AskUserQuestion', 'Skill'],
    });
  });

  it("keeps the session apart from the operator's Claude setup: no connectors, skills, MCP or memory", async () => {
    const { session, events, fake } = setup();
    await session.send({ text: 'hi' });
    await settled(events);
    expect(fake.calls[0]!.options).toMatchObject({
      settings: { disableClaudeAiConnectors: true, disableBundledSkills: true, autoMemoryEnabled: false },
      strictMcpConfig: true,
      skills: [],
    });
    expect((fake.calls[0]!.options as { disallowedTools?: string[] }).disallowedTools).toContain('Skill');
  });

  it('keeps one Claude Code process across turns and closes runs in order', async () => {
    const { session, events, fake } = setup([[result()], [result()]]);
    await session.send({ text: 'one' });
    await session.send({ text: 'two' });
    await settled(events, 2);
    expect(fake.calls).toHaveLength(1);
    expect(events.filter(e => e.type === 'run.ended').map(e => (e as { runId: string }).runId)).toEqual([
      'id-1',
      'id-3',
    ]);
  });

  it('reports an interrupted turn as aborted', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const events: FactoryEvent[] = [];
    const interrupt = vi.fn(async () => {
      release();
      return undefined;
    });
    const fn: QueryFn = ({ prompt }) =>
      Object.assign(
        (async function* () {
          for await (const _message of prompt) {
            await gate;
            yield result('error_during_execution');
          }
        })(),
        { interrupt, setModel: vi.fn(), close: vi.fn() },
      ) as unknown as Query;
    const session = new ClaudeAgentSession({
      sessionId: 's1',
      cwd: '/w',
      env: {},
      emit: e => events.push(e),
      query: fn,
    });

    await session.send({ text: 'long job' });
    await vi.waitFor(() => expect(session.status()).toBe('running'));
    await session.abort();
    await settled(events);
    expect(interrupt).toHaveBeenCalled();
    expect(events.find(e => e.type === 'run.ended')).toMatchObject({ reason: 'aborted' });
  });

  it('closes open runs with an error when Claude Code exits mid-turn, and restarts on the next send', async () => {
    const events: FactoryEvent[] = [];
    let starts = 0;
    const fn: QueryFn = ({ prompt, options }) => {
      starts++;
      const first = starts === 1;
      return Object.assign(
        (async function* () {
          for await (const _message of prompt) {
            if (first) throw new Error('claude exited with code 1');
            yield result();
          }
        })(),
        { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn(), options },
      ) as unknown as Query;
    };
    const session = new ClaudeAgentSession({
      sessionId: 's1',
      cwd: '/w',
      env: {},
      emit: e => events.push(e),
      query: fn,
    });

    await session.send({ text: 'one' });
    await settled(events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'claude exited with code 1' }));
    expect(events.find(e => e.type === 'run.ended')).toMatchObject({ reason: 'error' });

    await session.send({ text: 'two' });
    await settled(events, 2);
    expect(starts).toBe(2);
  });

  it('switches the live model and sends images as image blocks', async () => {
    const { session, events, fake } = setup([[result()]]);
    await session.send({ text: 'look', files: [{ data: 'data:image/png;base64,aGk=', mediaType: 'image/png' }] });
    await settled(events);
    await session.setModel('claude-sonnet-5-5');
    expect(fake.control.setModel).toHaveBeenCalledWith('claude-sonnet-5-5');
    expect(fake.seen[0]!.message.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ]);
  });
});

describe('claudeProcessEnv', () => {
  it('passes Claude credentials and basics through, and never server secrets', () => {
    const env = claudeProcessEnv(
      {
        HOME: '/home/u',
        PATH: '/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
        DATABASE_URL: 'postgres://secret',
        FACTORY_CREDENTIAL_ENCRYPTION_KEY: 'k',
        GITHUB_APP_PRIVATE_KEY: 'pem',
        MASTRA_PLATFORM_SECRET_KEY: 'p',
        WORKOS_API_KEY: 'w',
      },
      { GH_TOKEN: 'ghs_sandbox' },
    );
    expect(env).toEqual({
      HOME: '/home/u',
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
      GH_TOKEN: 'ghs_sandbox',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'factory',
    });
  });

  it("gives Claude Code a home of its own, overriding the operator's and any CLAUDE_CONFIG_DIR", () => {
    const env = claudeProcessEnv(
      { HOME: '/Users/tim', CLAUDE_CONFIG_DIR: '/Users/tim/.claude', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' },
      {},
      { home: '/srv/factory/claude-home/' },
    );
    expect(env).toMatchObject({
      HOME: '/srv/factory/claude-home/',
      CLAUDE_CONFIG_DIR: '/srv/factory/claude-home/.claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
    });
  });
});
