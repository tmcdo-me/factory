import { describe, expect, it, vi } from 'vitest';

import { SessionEventHub } from './event-hub';
import { InMemoryEventLog } from './event-log';
import { InteractionBroker, InteractionCancelledError } from './interaction-broker';
import { InMemoryInteractionStore } from './interaction-store-memory';
import type { InteractionRecord } from './interactions';

function setup(options: { onUndelivered?: (record: InteractionRecord) => Promise<void> } = {}) {
  const log = new InMemoryEventLog();
  const hub = new SessionEventHub(log);
  const store = new InMemoryInteractionStore();
  let n = 0;
  const broker = new InteractionBroker({ store, hub, newId: () => `i${++n}`, onUndelivered: options.onUndelivered });
  const eventTypes = async (sessionId = 's') => (await log.list(sessionId)).map(e => e.event.type);
  return { broker, store, eventTypes };
}

/** Wait until the broker has persisted and announced the pending interaction. */
async function pendingId(broker: InteractionBroker, sessionId = 's'): Promise<string> {
  await vi.waitFor(async () => expect(await broker.listPending({ sessionId })).toHaveLength(1));
  return (await broker.listPending({ sessionId }))[0]!.id;
}

describe('InteractionBroker', () => {
  it('delivers an answer to the live waiter and records the lifecycle as events', async () => {
    const { broker, eventTypes } = setup();
    const answer = broker.request('s', { kind: 'question', question: 'Which DB?' }, { callId: 'c1' });

    const id = await pendingId(broker);
    const outcome = await broker.resolve(id, { kind: 'question', answer: 'postgres' }, { resolvedBy: 'u1' });

    expect(outcome.status).toBe('delivered');
    await expect(answer).resolves.toEqual({ kind: 'question', answer: 'postgres' });
    expect(await eventTypes()).toEqual(['interaction.requested', 'interaction.resolved']);
    expect(await broker.listPending()).toEqual([]);
  });

  it('lets only the first of two answers win', async () => {
    const { broker } = setup();
    const answer = broker.request('s', { kind: 'plan_approval', planPath: 'plan.md' });
    const id = await pendingId(broker);

    const [first, second] = await Promise.all([
      broker.resolve(id, { kind: 'plan_approval', action: 'approved' }),
      broker.resolve(id, { kind: 'plan_approval', action: 'rejected', feedback: 'no' }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['delivered', 'not_pending']);
    await expect(answer).resolves.toMatchObject({ kind: 'plan_approval' });
  });

  it('rejects a response of the wrong kind without settling', async () => {
    const { broker } = setup();
    void broker.request('s', { kind: 'tool_approval', toolName: 'push', input: {} }).catch(() => {});
    const id = await pendingId(broker);

    await expect(broker.resolve(id, { kind: 'question', answer: 'yes' })).rejects.toThrow(/expects a "tool_approval"/);
    expect(await broker.listPending()).toHaveLength(1);
  });

  it('cancels on abort and rejects the waiter', async () => {
    const { broker, eventTypes } = setup();
    const controller = new AbortController();
    const answer = broker.request('s', { kind: 'question', question: '?' }, { signal: controller.signal });
    await pendingId(broker);

    controller.abort();
    await expect(answer).rejects.toBeInstanceOf(InteractionCancelledError);
    await vi.waitFor(async () =>
      expect(await eventTypes()).toEqual(['interaction.requested', 'interaction.cancelled']),
    );
  });

  it('hands an answer with no live waiter (e.g. after a restart) to onUndelivered', async () => {
    const onUndelivered = vi.fn(async () => {});
    const { broker: beforeRestart, store } = setup();
    void beforeRestart.request('s', { kind: 'plan_approval', planPath: 'plan.md' }).catch(() => {});
    const id = await pendingId(beforeRestart);

    // A fresh broker over the same store models the restarted process.
    const afterRestart = new InteractionBroker({
      store,
      hub: new SessionEventHub(new InMemoryEventLog()),
      onUndelivered,
    });
    const outcome = await afterRestart.resolve(id, { kind: 'plan_approval', action: 'approved' });

    expect(outcome.status).toBe('queued');
    expect(onUndelivered).toHaveBeenCalledWith(expect.objectContaining({ id, status: 'resolved' }));
  });

  it('cancelSession cancels only that session', async () => {
    const { broker } = setup();
    const a = broker.request('a', { kind: 'question', question: '1' });
    void broker.request('b', { kind: 'question', question: '2' }).catch(() => {});
    await pendingId(broker, 'a');
    await pendingId(broker, 'b');

    expect(await broker.cancelSession('a', 'closed')).toBe(1);
    await expect(a).rejects.toMatchObject({ reason: 'closed' });
    expect(await broker.listPending({ sessionId: 'b' })).toHaveLength(1);
  });
});
