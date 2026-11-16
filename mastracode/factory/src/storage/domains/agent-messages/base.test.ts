// fork(claude-agent)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createIsolatedFactoryPostgresForTests } from '../../test-utils.js';
import { AGENT_MESSAGE_RETENTION_MS, AgentMessagesStorage } from './base.js';
import type { AgentMessage, AgentMessageStore } from './base.js';
import { InMemoryAgentMessages } from './memory.js';

const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;

async function onPostgres(): Promise<AgentMessageStore> {
  const storage = await createIsolatedFactoryPostgresForTests(postgresUrl!);
  const messages = storage.registerDomain(new AgentMessagesStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return messages;
}

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
  ['libsql', stored, true],
  ...(postgresUrl ? ([['postgres', onPostgres, true]] as const) : []),
  ['memory', async () => new InMemoryAgentMessages(), false],
] as const)('AgentMessageStore (%s)', (_name, open, durable) => {
  it('says whether it survives a restart', async () => {
    expect((await open()).durable).toBe(durable);
  });

  const lease = () => new Date(Date.now() + 15 * 60_000);
  const lapsed = () => new Date(Date.now() - 1);

  it('gives the right to answer a message once, even to two racing answers, and takes it back', async () => {
    const messages = await open();
    await messages.told(fromSession('m1'));
    const claims = await Promise.all([
      messages.claimReply('s1', 'm1', lease()),
      messages.claimReply('s1', 'm1', lease()),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    // Another session's answer to the same id is its own.
    expect(await messages.claimReply('s2', 'm1', lease())).toBe(true);
    // The mark is no message: nothing reads it as one.
    expect(await messages.get('s1', 'reply:m1:s1')).toBeUndefined();
    expect((await messages.recentOnThread('s1', 10)).map(row => row.id)).toEqual(['m1']);
    expect(await messages.take('s1')).toEqual({ messages: [], dropped: 0 });

    await messages.releaseReply('s1', 'm1');
    expect(await messages.claimReply('s1', 'm1', lease())).toBe(true);
  });

  it('lets a claim left unconfirmed lapse at its lease, and holds a confirmed one for good', async () => {
    const messages = await open();
    // The server stopped between claiming and confirming: the claim's lease runs out.
    expect(await messages.claimReply('s1', 'm1', lapsed())).toBe(true);
    const retries = await Promise.all([
      messages.claimReply('s1', 'm1', lease()),
      messages.claimReply('s1', 'm1', lease()),
    ]);
    expect(retries.sort()).toEqual([false, true]);

    // Held longer while queued, then confirmed: no later answer, lease or not.
    await messages.extendReply('s1', 'm1', lapsed());
    expect(await messages.claimReply('s1', 'm1', lease())).toBe(true);
    await messages.confirmReply('s1', 'm1');
    await messages.releaseReply('s1', 'm1');
    expect(await messages.claimReply('s1', 'm1', lease())).toBe(false);
    await messages.extendReply('s1', 'm1', lapsed());
    expect(await messages.claimReply('s1', 'm1', lease())).toBe(false);
  });

  it('keeps a message that waited past retention answerable once Claude reads it', async () => {
    const messages = await open();
    await messages.hold({ ...fromSession('m-week'), createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) }, 20);
    expect((await messages.take('s1')).messages.map(row => row.id)).toEqual(['m-week']);

    await messages.forgetBefore(new Date(Date.now() - AGENT_MESSAGE_RETENTION_MS));
    expect(await messages.get('s1', 'm-week')).toMatchObject({ status: 'told' });
    expect(await messages.claimReply('s1', 'm-week', lease())).toBe(true);
  });

  it('forgets a message kept for a turn that never started', async () => {
    const messages = await open();
    await messages.told(fromSession('m1'));
    await messages.forget('s2', 'm1');
    expect(await messages.get('s1', 'm1')).toBeDefined();
    await messages.forget('s1', 'm1');
    expect(await messages.get('s1', 'm1')).toBeUndefined();
  });

  it('forgets what no longer waits once it is old, and never what still waits', async () => {
    const messages = await open();
    const old = new Date(Date.now() - AGENT_MESSAGE_RETENTION_MS - 60_000);
    // Read by Claude a week and more ago.
    vi.useFakeTimers({ toFake: ['Date'], now: old });
    try {
      await messages.told({ ...fromSession('old-told'), createdAt: old });
    } finally {
      vi.useRealTimers();
    }
    await messages.hold({ ...message('old-overflow'), createdAt: old }, 20);
    await messages.hold({ ...message('old-waiting'), createdAt: new Date(old.getTime() + 1) }, 1);
    await messages.told(fromSession('new-told'));

    // Writes sweep now and then on their own; an explicit sweep finishes the job.
    await messages.forgetBefore(new Date(Date.now() - AGENT_MESSAGE_RETENTION_MS));
    expect(await messages.get('s1', 'old-told')).toBeUndefined();
    expect(await messages.get('s1', 'new-told')).toBeDefined();
    // `old-overflow` was dropped for the newer `old-waiting`, which still waits however old it is.
    expect(await messages.take('s1')).toMatchObject({ messages: [{ id: 'old-waiting' }], dropped: 0 });
  });

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
