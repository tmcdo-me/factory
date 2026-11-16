// fork(claude-agent)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentMessagesStorage } from './base.js';
import type { AgentMessage, AgentMessageStore } from './base.js';
import { InMemoryAgentMessages } from './memory.js';

async function stored(): Promise<AgentMessageStore> {
  const storage = new LibSQLFactoryStorage({ id: 'agent-messages-test', url: ':memory:' });
  const messages = storage.registerDomain(new AgentMessagesStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return messages;
}

let clock = Date.parse('2030-01-01T00:00:00.000Z');
function message(id: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  clock += 1;
  return { id, sessionId: 's1', source: 'rule-message', text: `text of ${id}`, createdAt: new Date(clock), ...extra };
}

const fromSession = (id: string, threadId = 's1'): AgentMessage =>
  message(id, {
    source: 'factory-session',
    attributes: { kind: 'message', 'from-session': 'sender', id },
    delivery: { threadId, kind: 'message', priority: 'medium', sourceId: 'sender' },
  });

describe.each([
  ['storage', stored],
  ['memory', async () => new InMemoryAgentMessages()],
] as const)('AgentMessageStore (%s)', (_name, open) => {
  it('hands each waiting message to one turn, oldest first, then forgets it was waiting', async () => {
    const messages = await open();
    await messages.hold(message('m1'), 20);
    await messages.hold(fromSession('m2'), 20);
    await messages.hold(message('m3', { sessionId: 's2' }), 20);

    const [first, second] = await Promise.all([messages.take('s1'), messages.take('s1')]);
    const taken = [...first.messages, ...second.messages];
    expect(taken.map(row => row.id)).toEqual(['m1', 'm2']);
    expect(taken[1]).toMatchObject({
      status: 'told',
      source: 'factory-session',
      text: 'text of m2',
      attributes: { kind: 'message', 'from-session': 'sender', id: 'm2' },
      delivery: { threadId: 's1', kind: 'message', priority: 'medium', sourceId: 'sender' },
    });
    expect(await messages.take('s1')).toEqual({ messages: [], dropped: 0 });
    expect((await messages.take('s2')).messages.map(row => row.id)).toEqual(['m3']);
  });

  it('keeps at most `cap` waiting, and counts the dropped ones toward one turn only', async () => {
    const messages = await open();
    let dropped = 0;
    for (let n = 1; n <= 5; n += 1) dropped += await messages.hold(message(`m${n}`), 3);
    expect(dropped).toBe(2);

    const turn = await messages.take('s1');
    expect(turn.messages.map(row => row.id)).toEqual(['m3', 'm4', 'm5']);
    expect(turn.dropped).toBe(2);
    expect((await messages.take('s1')).dropped).toBe(0);
  });

  it('finds a notification the session was sent, and only for that session', async () => {
    const messages = await open();
    await messages.told(fromSession('m1'));
    await messages.hold(fromSession('m2'), 20);

    expect(await messages.get('s1', 'm1')).toMatchObject({ status: 'told', delivery: { kind: 'message' } });
    expect(await messages.get('s1', 'm2')).toMatchObject({ status: 'held' });
    expect(await messages.get('s2', 'm1')).toBeUndefined();
    expect(await messages.get('s1', 'nope')).toBeUndefined();
  });

  it("lists a thread's newest notifications first, held or read", async () => {
    const messages = await open();
    await messages.told(fromSession('m1'));
    await messages.hold(fromSession('m2'), 20);
    await messages.told(fromSession('m3', 'other'));
    await messages.told(message('m4'));
    await messages.told(fromSession('m5'));

    expect((await messages.recentOnThread('s1', 10)).map(row => row.id)).toEqual(['m5', 'm2', 'm1']);
    expect((await messages.recentOnThread('s1', 2)).map(row => row.id)).toEqual(['m5', 'm2']);
    expect((await messages.recentOnThread('other', 10)).map(row => row.id)).toEqual(['m3']);
  });
});

describe('AgentMessagesStorage', () => {
  it('keeps what waits across a restart: the next process takes it with its first turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-messages-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, 'factory.db')}`;
    const open = async () => {
      const storage = new LibSQLFactoryStorage({ id: 'agent-messages-restart', url });
      const messages = storage.registerDomain(new AgentMessagesStorage());
      await storage.init();
      return { storage, messages };
    };

    const before = await open();
    await before.messages.hold(fromSession('m1'), 20);
    await before.storage.close();

    const after = await open();
    onTestFinished(() => after.storage.close());
    expect((await after.messages.take('s1')).messages.map(row => row.id)).toEqual(['m1']);
  });
});
