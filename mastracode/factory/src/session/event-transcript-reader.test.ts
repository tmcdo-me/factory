import { InMemoryEventLog } from '@factory/agent-runtime';
import type { FactoryEvent } from '@factory/agent-runtime';
import { describe, expect, it } from 'vitest';

import { eventTranscriptReader, listFinishedToolCalls } from './event-transcript-reader.js';

async function logOf(...events: FactoryEvent[]) {
  const log = new InMemoryEventLog();
  await log.append('s1', events);
  return log;
}

const call = (callId: string, name = 'submit_plan'): FactoryEvent[] => [
  { type: 'tool.started', callId, name, category: 'other', executor: 'runtime' } as FactoryEvent,
  { type: 'tool.input', callId, input: { plan: 'p' } },
];

describe('listFinishedToolCalls', () => {
  it('names the assistant message a call finished in, the next one when none is open, and the call id otherwise', async () => {
    const log = await logOf(
      { type: 'run.started', runId: 'r1', threadId: 't1' },
      { type: 'message.started', messageId: 'm1', role: 'assistant' },
      ...call('c1'),
      { type: 'tool.ended', callId: 'c1', result: 'Plan approved.' },
      { type: 'message.ended', messageId: 'm1' },
      ...call('c2'),
      { type: 'tool.ended', callId: 'c2', error: 'boom' },
      { type: 'message.started', messageId: 'm2', role: 'assistant' },
      { type: 'message.ended', messageId: 'm2' },
      ...call('c3'),
      { type: 'tool.ended', callId: 'c3', result: 'x' },
      { type: 'run.ended', runId: 'r1', reason: 'complete' },
    );
    const read = await listFinishedToolCalls(log, { sessionId: 's1', threadId: 't1' });
    expect(read.map(message => message.id)).toEqual(['m1', 'm2', 'c3']);
    expect(JSON.stringify(read[0]!.content)).toContain('Plan approved.');
    expect(JSON.stringify(read[1]!.content)).toContain('"state":"error"');
  });

  it('reads only the bound thread, and skips denied calls and runs that name no thread', async () => {
    const log = await logOf(
      { type: 'run.started', runId: 'r0' },
      ...call('old'),
      { type: 'tool.ended', callId: 'old', result: 1 },
      { type: 'run.ended', runId: 'r0', reason: 'complete' },
      { type: 'run.started', runId: 'r1', threadId: 'other' },
      ...call('elsewhere'),
      { type: 'tool.ended', callId: 'elsewhere', result: 1 },
      { type: 'run.ended', runId: 'r1', reason: 'complete' },
      { type: 'run.started', runId: 'r2', threadId: 't1' },
      ...call('denied'),
      { type: 'tool.ended', callId: 'denied', denied: true },
      ...call('mine'),
      { type: 'tool.ended', callId: 'mine', result: 1 },
      { type: 'run.ended', runId: 'r2', reason: 'complete' },
    );
    const read = await listFinishedToolCalls(log, { sessionId: 's1', threadId: 't1' });
    expect(read.map(message => message.id)).toEqual(['mine']);
  });

  it('serves the processor reader: a start time, and pages', async () => {
    const log = await logOf(
      { type: 'run.started', runId: 'r1', threadId: 't1' },
      ...call('a'),
      { type: 'tool.ended', callId: 'a', result: 1 },
      ...call('b'),
      { type: 'tool.ended', callId: 'b', result: 1 },
    );
    const reader = eventTranscriptReader(log);
    const first = await reader.listMessages({ threadId: 't1', sessionId: 's1', page: 0, perPage: 1 });
    expect(first.messages.map(message => message.id)).toEqual(['a']);
    expect(first.hasMore).toBe(true);
    const late = await reader.listMessages({
      threadId: 't1',
      sessionId: 's1',
      page: 0,
      perPage: 10,
      filter: { dateRange: { start: new Date(Date.now() + 60_000) } },
    });
    expect(late.messages).toEqual([]);
    expect(await reader.listMessages({ threadId: 't1', page: 0, perPage: 10 })).toEqual({
      messages: [],
      hasMore: false,
    });
  });
});
