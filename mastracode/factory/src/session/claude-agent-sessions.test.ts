// fork(claude-agent)
import { InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import type { SessionCommands } from '@factory/agent-runtime';
import type { QueryFn } from '@factory/runtime-claude-agent';
import { describe, expect, it, vi } from 'vitest';

import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';
import { ClaudeAgentSessions, routeSessionCommands } from './claude-agent-sessions.js';

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

function setup(records: AgentSessionRecord[]) {
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
