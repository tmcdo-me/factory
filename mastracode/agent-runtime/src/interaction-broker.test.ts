import { describe, expect, it, vi } from 'vitest';

import type { CommandResult } from './commands';
import { SessionEventHub } from './event-hub';
import { InMemoryEventLog } from './event-log';
import {
  HELD_INTERACTION_GONE,
  InteractionAnswerRefusedError,
  InteractionBroker,
  InteractionCancelledError,
} from './interaction-broker';
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

/**
 * A runtime that holds its own interactions (Mastra Code's controller resumes its suspended and gated
 * calls): the broker records what the runtime reports and hands answers to it, and the runtime decides.
 */
describe('InteractionBroker with interactions a runtime holds', () => {
  function heldSetup(
    answerHeld: (record: InteractionRecord, response: unknown, options: unknown) => Promise<CommandResult>,
  ) {
    const log = new InMemoryEventLog();
    const hub = new SessionEventHub(log);
    const store = new InMemoryInteractionStore();
    const broker = new InteractionBroker({ store, hub, answerHeld: answerHeld as never });
    const ask = (callId = 'call-1') =>
      broker.track({
        id: `question:${callId}`,
        sessionId: 's',
        callId,
        heldBy: 'mastra-code',
        request: { kind: 'question', question: 'Which branch?' },
        requestedAt: new Date().toISOString(),
      });
    return { broker, store, log, ask };
  }

  it('hands the answer to the runtime with its request context and settles it once the runtime accepts', async () => {
    const answerHeld = vi.fn(async () => ({ ok: true }) as const);
    const { broker, store, log, ask } = heldSetup(answerHeld);
    const record = await ask();

    const outcome = await broker.resolve(
      record.id,
      { kind: 'question', answer: 'main' },
      { resolvedBy: 'u1', context: 'ctx' },
    );

    expect(outcome.status).toBe('delivered');
    expect(answerHeld).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question:call-1', callId: 'call-1' }),
      { kind: 'question', answer: 'main' },
      { resolvedBy: 'u1', context: 'ctx' },
    );
    expect(await store.get(record.id)).toMatchObject({
      status: 'resolved',
      resolvedBy: 'u1',
      response: { answer: 'main' },
    });
    // The runtime's own event stream announces it and its answer; the broker adds nothing.
    expect(await log.list('s')).toEqual([]);
  });

  it('lets one of two answers through to the runtime; the other is not pending', async () => {
    let accept!: () => void;
    const answerHeld = vi.fn(() => new Promise<CommandResult>(resolve => (accept = () => resolve({ ok: true }))));
    const { broker, ask } = heldSetup(answerHeld);
    const record = await ask();

    const first = broker.resolve(record.id, { kind: 'question', answer: 'main' });
    await vi.waitFor(() => expect(answerHeld).toHaveBeenCalledTimes(1));
    const second = await broker.resolve(record.id, { kind: 'question', answer: 'release/1.x' });
    accept();

    expect(second.status).toBe('not_pending');
    expect((await first).status).toBe('delivered');
    expect(answerHeld).toHaveBeenCalledTimes(1);
  });

  it('settles an interaction the runtime no longer holds when it says so, and leaves one it could not reach', async () => {
    const results: CommandResult[] = [
      { ok: false, reason: 'not_pending', message: 'no_pending_suspension' },
      { ok: false, reason: 'session_not_found' },
    ];
    const { broker, store, ask } = heldSetup(async () => results.shift()!);
    const gone = await ask('call-1');
    const unreachable = await ask('call-2');

    expect((await broker.resolve(gone.id, { kind: 'question', answer: 'main' })).status).toBe('not_pending');
    expect(await store.get(gone.id)).toMatchObject({ status: 'cancelled', cancelReason: HELD_INTERACTION_GONE });

    await expect(broker.resolve(unreachable.id, { kind: 'question', answer: 'main' })).rejects.toBeInstanceOf(
      InteractionAnswerRefusedError,
    );
    expect(await store.get(unreachable.id)).toMatchObject({ status: 'pending' });
  });

  it('settles as the runtime reports, even while an answer is with it', async () => {
    let accept!: (result: CommandResult) => void;
    const { broker, store, ask } = heldSetup(() => new Promise<CommandResult>(resolve => (accept = resolve)));
    const answered = await ask('call-1');
    const abandoned = await ask('call-2');

    // Answered in the session itself: the runtime's events settle it.
    expect(await broker.settleHeld(abandoned.id, { status: 'cancelled', reason: 'aborted' })).toBe(true);
    expect(await store.get(abandoned.id)).toMatchObject({ status: 'cancelled', cancelReason: 'aborted' });

    // The runtime's events say the call moved on before its answer returns: the answer's outcome decides.
    const outcome = broker.resolve(answered.id, { kind: 'question', answer: 'main' }, { resolvedBy: 'u1' });
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
    expect(await broker.settleHeld(answered.id, { status: 'cancelled', reason: 'withdrawn' })).toBe(false);
    accept({ ok: true });
    expect((await outcome).status).toBe('delivered');
    expect(await store.get(answered.id)).toMatchObject({ status: 'resolved', resolvedBy: 'u1' });
  });

  // A resume that drops the call from the session's state, then fails and puts it back: the call
  // still waits, though the runtime's events said it was gone while the answer was with it.
  it('keeps a call pending when the runtime refuses its answer and still waits on it', async () => {
    let accept!: (result: CommandResult) => void;
    const { broker, store, ask } = heldSetup(() => new Promise<CommandResult>(resolve => (accept = resolve)));
    const held = await ask('call-1');

    const outcome = broker.resolve(held.id, { kind: 'question', answer: 'main' }, { resolvedBy: 'u1' });
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
    await broker.settleHeld(held.id, { status: 'cancelled', reason: 'gone' });
    accept({ ok: false, reason: 'invalid', message: 'the session still waits on it', waiting: true });

    await expect(outcome).rejects.toBeInstanceOf(InteractionAnswerRefusedError);
    expect(await store.get(held.id)).toMatchObject({ status: 'pending' });
  });

  it('forgets what the runtime said of a call while its answer was out once it reports the call waiting again', async () => {
    let accept!: (result: CommandResult) => void;
    const { broker, store, ask } = heldSetup(() => new Promise<CommandResult>(resolve => (accept = resolve)));
    const held = await ask('call-1');

    const outcome = broker.resolve(held.id, { kind: 'question', answer: 'main' });
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
    await broker.settleHeld(held.id, { status: 'cancelled', reason: 'gone' });
    expect((await ask('call-1')).id).toBe(held.id);
    accept({ ok: false, reason: 'invalid' });

    await expect(outcome).rejects.toBeInstanceOf(InteractionAnswerRefusedError);
    expect(await store.get(held.id)).toMatchObject({ status: 'pending' });
  });

  it('settles as the runtime reported when handing it the answer fails', async () => {
    const { broker, store, ask } = heldSetup(async () => {
      await broker.settleHeld('question:call-1', { status: 'cancelled', reason: 'aborted' });
      throw new Error('connection lost');
    });
    const held = await ask('call-1');

    await expect(broker.resolve(held.id, { kind: 'question', answer: 'main' })).rejects.toThrow('connection lost');
    expect(await store.get(held.id)).toMatchObject({ status: 'cancelled', cancelReason: 'aborted' });
  });

  it('names who answered a call in its own session once the runtime reports it answered', async () => {
    const { broker, store, ask } = heldSetup(async () => ({ ok: true }));
    const held = await ask('call-1');
    const dropped = await ask('call-2');

    broker.attribute(held.id, { resolvedBy: 'u1' });
    broker.attribute(dropped.id, { resolvedBy: 'u2' })();
    await broker.settleHeld(held.id, { status: 'resolved', response: { kind: 'question', answer: 'main' } });
    await broker.settleHeld(dropped.id, { status: 'resolved', response: { kind: 'question', answer: 'x' } });

    expect(await store.get(held.id)).toMatchObject({ status: 'resolved', resolvedBy: 'u1' });
    expect((await store.get(dropped.id))?.resolvedBy).toBeUndefined();
  });

  // Review fix: an in-session answer whose resume failed (the call reported waiting again) names nobody.
  it('forgets who answered in the session when the call comes back waiting', async () => {
    const { broker, store, ask } = heldSetup(async () => ({ ok: true }));
    const held = await ask('call-1');
    broker.attribute(held.id, { resolvedBy: 'u1' });
    expect((await ask('call-1')).id).toBe(held.id);
    await broker.settleHeld(held.id, { status: 'resolved', response: { kind: 'question', answer: 'main' } });

    expect((await store.get(held.id))?.resolvedBy).toBeUndefined();
  });

  it('keeps one record per waiting call, and a fresh one when the call id comes back after it settled', async () => {
    const { broker, ask } = heldSetup(async () => ({ ok: true }));
    const first = await ask();
    expect((await ask()).id).toBe(first.id);
    expect(await broker.listPending({ sessionId: 's' })).toHaveLength(1);

    await broker.settleHeld(first.id, { status: 'cancelled', reason: 'aborted' });
    const again = await ask();
    expect(again.id).toBe('question:call-1#2');
    expect(await broker.listPending({ sessionId: 's' })).toEqual([
      expect.objectContaining({ id: 'question:call-1#2' }),
    ]);
  });

  it('never takes an answer for a call only its session can answer', async () => {
    const answerHeld = vi.fn(async () => ({ ok: true }) as const);
    const { broker } = heldSetup(answerHeld);
    const record = await broker.track({
      id: 'tool_input:call-9',
      sessionId: 's',
      callId: 'call-9',
      heldBy: 'mastra-code',
      request: { kind: 'tool_input', toolName: 'request_access', input: { path: '/etc' } },
      requestedAt: new Date().toISOString(),
    });

    await expect(broker.resolve(record.id, { kind: 'question', answer: 'yes' })).rejects.toThrow(
      /expects a "tool_input"/,
    );
    expect(answerHeld).not.toHaveBeenCalled();
  });
});
