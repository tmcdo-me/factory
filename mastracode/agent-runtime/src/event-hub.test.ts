import { describe, expect, it, vi } from 'vitest';

import { SessionEventHub } from './event-hub';
import { InMemoryEventLog } from './event-log';
import type { EventEnvelope, FactoryEvent } from './events';

const text = (delta: string): FactoryEvent => ({ type: 'message.delta', messageId: 'm1', part: 'text', delta });

async function take(iterator: AsyncGenerator<EventEnvelope>, count: number): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  while (out.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

describe('SessionEventHub', () => {
  it('assigns consecutive seq numbers per session, independent across sessions', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    await hub.publish('a', text('1'), text('2'));
    await hub.publish('b', text('x'));
    await hub.publish('a', text('3'));

    expect((await hub.log.list('a')).map(e => e.seq)).toEqual([1, 2, 3]);
    expect((await hub.log.list('b')).map(e => e.seq)).toEqual([1]);
  });

  it('keeps publish order even when publishes are not awaited', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    await Promise.all(['a', 'b', 'c', 'd'].map(delta => hub.publish('s', text(delta))));

    const deltas = (await hub.log.list('s')).map(e => (e.event as { delta: string }).delta);
    expect(deltas).toEqual(['a', 'b', 'c', 'd']);
  });

  it('replays stored events after afterSeq, then delivers live ones without gaps or duplicates', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    await hub.publish('s', text('1'), text('2'), text('3'));

    const controller = new AbortController();
    const subscription = hub.subscribe('s', { afterSeq: 1, signal: controller.signal });
    const replayed = await take(subscription, 2);
    expect(replayed.map(e => e.seq)).toEqual([2, 3]);

    const live = take(subscription, 2);
    await hub.publish('s', text('4'));
    await hub.publish('s', text('5'));
    expect((await live).map(e => e.seq)).toEqual([4, 5]);

    controller.abort();
    expect((await subscription.next()).done).toBe(true);
  });

  it('does not lose events published while the replay is in progress', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    await hub.publish('s', text('1'));

    const subscription = hub.subscribe('s');
    const first = await subscription.next(); // replay has started and subscriber is registered
    await hub.publish('s', text('2'));
    const rest = await take(subscription, 1);

    expect([first.value!.seq, ...rest.map(e => e.seq)]).toEqual([1, 2]);
    await subscription.return(undefined);
  });

  it('stops promptly when aborted while waiting for live events', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    const controller = new AbortController();
    const subscription = hub.subscribe('s', { signal: controller.signal });
    const pending = subscription.next();
    controller.abort();
    expect((await pending).done).toBe(true);
  });

  it('calls live listeners with stored events from now on, and stops when told to', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    await hub.publish('s', text('old'));
    const heard: number[] = [];
    const stop = hub.listen('s', envelope => heard.push(envelope.seq));
    await hub.publish('other', text('elsewhere'));
    await hub.publish('s', text('1'), text('2'));
    stop();
    await hub.publish('s', text('3'));

    expect(heard).toEqual([2, 3]);
  });

  it('keeps publishing when a listener throws', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heard: number[] = [];
    hub.listen('s', () => {
      throw new Error('boom');
    });
    hub.listen('s', envelope => heard.push(envelope.seq));

    await expect(hub.publish('s', text('1'))).resolves.toHaveLength(1);
    expect(heard).toEqual([1]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
