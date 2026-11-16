// fork(claude-agent)
import { InteractionBroker, SessionEventHub, buildTranscript } from '@factory/agent-runtime';
import type { FactoryEvent } from '@factory/agent-runtime';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AgentInteractionsStorage } from '../agent-interactions/base.js';
import { AgentEventsStorage } from './base.js';

async function setup() {
  const storage = new LibSQLFactoryStorage({ id: 'agent-events-test', url: ':memory:' });
  const events = storage.registerDomain(new AgentEventsStorage());
  const interactions = storage.registerDomain(new AgentInteractionsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return { events, interactions };
}

const delta = (text: string): FactoryEvent => ({ type: 'message.delta', messageId: 'm1', part: 'text', delta: text });

describe('AgentEventsStorage', () => {
  it('appends with consecutive seq per session and lists after a seq', async () => {
    const { events } = await setup();
    const first = await events.append('s1', [delta('a'), delta('b')]);
    await events.append('s2', [delta('x')]);
    await events.append('s1', [delta('c')]);

    expect(first.map(e => e.seq)).toEqual([1, 2]);
    expect(first[0]).toMatchObject({ sessionId: 's1', event: delta('a') });
    expect(typeof first[0]!.at).toBe('string');

    expect((await events.list('s1')).map(e => e.seq)).toEqual([1, 2, 3]);
    expect((await events.list('s1', { afterSeq: 1 })).map(e => (e.event as { delta: string }).delta)).toEqual([
      'b',
      'c',
    ]);
    expect((await events.list('s1', { afterSeq: 1, limit: 1 })).map(e => e.seq)).toEqual([2]);
    expect((await events.list('s2')).map(e => e.seq)).toEqual([1]);
    expect(await events.list('none')).toEqual([]);
  });

  it('keeps seq unique and gap-free under concurrent unserialized appends', async () => {
    const { events } = await setup();
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(text => events.append('s1', [delta(text)])));
    const stored = await events.list('s1');
    expect(stored.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(stored.map(e => (e.event as { delta: string }).delta))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('round-trips structured events and backs a hub transcript', async () => {
    const { events } = await setup();
    const hub = new SessionEventHub(events);
    await hub.publish(
      's1',
      { type: 'run.started', runId: 'r1' },
      {
        type: 'tool.started',
        callId: 'c1',
        name: 'view',
        category: 'file.read',
        executor: 'runtime',
        input: { path: 'a.ts' },
      },
      { type: 'tool.ended', callId: 'c1', result: { lines: 3, nested: { ok: true } } },
      { type: 'run.ended', runId: 'r1', reason: 'complete' },
    );
    const transcript = buildTranscript('s1', await events.list('s1'));
    expect(transcript.items).toMatchObject([
      { kind: 'run', status: 'complete' },
      { kind: 'tool', input: { path: 'a.ts' }, result: { lines: 3, nested: { ok: true } }, status: 'done' },
    ]);
  });

  it('deletes one session', async () => {
    const { events } = await setup();
    await events.append('s1', [delta('a')]);
    await events.append('s2', [delta('b')]);
    expect(await events.deleteSession('s1')).toBe(1);
    expect(await events.list('s1')).toEqual([]);
    expect(await events.list('s2')).toHaveLength(1);
  });
});

describe('AgentInteractionsStorage', () => {
  it('creates, settles exactly once, and lists only pending', async () => {
    const { interactions } = await setup();
    await interactions.create({
      id: 'i1',
      sessionId: 's1',
      callId: 'c1',
      request: { kind: 'plan_approval', planPath: 'plan.md' },
      requestedAt: '2026-11-15T00:00:00.000Z',
      status: 'pending',
    });
    await interactions.create({
      id: 'i2',
      sessionId: 's2',
      request: { kind: 'question', question: '?' },
      requestedAt: '2026-11-15T00:00:01.000Z',
      status: 'pending',
    });

    expect((await interactions.listPending()).map(r => r.id)).toEqual(['i1', 'i2']);
    expect((await interactions.listPending({ sessionId: 's2' })).map(r => r.id)).toEqual(['i2']);

    const settled = await interactions.settle('i1', {
      status: 'resolved',
      response: { kind: 'plan_approval', action: 'approved' },
      resolvedBy: 'u1',
      settledAt: '2026-11-15T00:01:00.000Z',
    });
    expect(settled).toMatchObject({ id: 'i1', status: 'resolved', resolvedBy: 'u1', callId: 'c1' });
    expect(
      await interactions.settle('i1', {
        status: 'cancelled',
        cancelReason: 'late',
        settledAt: '2026-11-15T00:02:00.000Z',
      }),
    ).toBeUndefined();
    expect(await interactions.get('i1')).toMatchObject({ status: 'resolved', response: { action: 'approved' } });
    expect(
      await interactions.settle('missing', { status: 'cancelled', cancelReason: 'x', settledAt: 'x' }),
    ).toBeUndefined();
    expect((await interactions.listPending()).map(r => r.id)).toEqual(['i2']);
  });

  it('backs the InteractionBroker end to end', async () => {
    const { events, interactions } = await setup();
    const broker = new InteractionBroker({ store: interactions, hub: new SessionEventHub(events) });
    const answer = broker.request('s1', { kind: 'question', question: 'Proceed?' }, { callId: 'c9' });

    await vi.waitFor(async () => expect(await broker.listPending({ sessionId: 's1' })).toHaveLength(1));
    const [pending] = await broker.listPending({ sessionId: 's1' });
    expect((await broker.resolve(pending!.id, { kind: 'question', answer: 'yes' })).status).toBe('delivered');
    await expect(answer).resolves.toEqual({ kind: 'question', answer: 'yes' });
    expect((await events.list('s1')).map(e => e.event.type)).toEqual(['interaction.requested', 'interaction.resolved']);
  });
});
