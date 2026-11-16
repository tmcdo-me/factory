import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionEventHub } from './event-hub';
import { InMemoryEventLog } from './event-log';
import type { FactoryEvent } from './events';
import { SessionPublisher } from './session-publisher';

const delta = (text: string, messageId = 'm1', part: 'text' | 'reasoning' = 'text'): FactoryEvent => ({
  type: 'message.delta',
  messageId,
  part,
  delta: text,
});

function setup(flushMs = 100) {
  const log = new InMemoryEventLog();
  const publisher = new SessionPublisher(new SessionEventHub(log), 's', { flushMs });
  const stored = async () => (await log.list('s')).map(e => e.event);
  return { publisher, stored };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionPublisher', () => {
  it('merges consecutive deltas for the same message part', async () => {
    const { publisher, stored } = setup();
    for (const piece of ['Hel', 'lo', ' wor', 'ld']) publisher.emit(delta(piece));
    await publisher.flush();
    expect(await stored()).toEqual([delta('Hello world')]);
  });

  it('flushes before any other event, preserving order', async () => {
    const { publisher, stored } = setup();
    publisher.emit(delta('a'));
    publisher.emit(delta('b', 'm1', 'reasoning'));
    publisher.emit({ type: 'message.ended', messageId: 'm1' });
    publisher.emit(delta('c', 'm2'));
    await publisher.flush();

    expect(await stored()).toEqual([
      delta('a'),
      delta('b', 'm1', 'reasoning'),
      { type: 'message.ended', messageId: 'm1' },
      delta('c', 'm2'),
    ]);
  });

  it('merges tool output per call and stream', async () => {
    const { publisher, stored } = setup();
    publisher.emit({ type: 'tool.output', callId: 'c1', stream: 'stdout', chunk: 'a' });
    publisher.emit({ type: 'tool.output', callId: 'c1', stream: 'stdout', chunk: 'b' });
    publisher.emit({ type: 'tool.output', callId: 'c1', stream: 'stderr', chunk: 'x' });
    await publisher.flush();
    expect(await stored()).toEqual([
      { type: 'tool.output', callId: 'c1', stream: 'stdout', chunk: 'ab' },
      { type: 'tool.output', callId: 'c1', stream: 'stderr', chunk: 'x' },
    ]);
  });

  it('flushes held deltas after flushMs without further events', async () => {
    vi.useFakeTimers();
    const { publisher, stored } = setup(50);
    publisher.emit(delta('x'));
    expect(await stored()).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(await stored()).toEqual([delta('x')]);
  });

  it('reports storage failures instead of throwing into the runtime', async () => {
    const onError = vi.fn();
    const hub = new SessionEventHub({
      append: async () => {
        throw new Error('db down');
      },
      list: async () => [],
    });
    const publisher = new SessionPublisher(hub, 's', { onError });
    expect(() => publisher.emit({ type: 'message.ended', messageId: 'm1' })).not.toThrow();
    await publisher.flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
  });
});
