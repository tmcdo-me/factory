/**
 * Whether a Mastra Code session's conversation is all in Factory's event log, against a real
 * AgentController (mock model) whose turns are mirrored into a real event log, as Factory does.
 */
import { InMemoryEventLog, SessionEventHub, SessionPublisher } from '@factory/agent-runtime';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { historyPredatesEventLog } from './history';
import { mirrorSessionEvents } from './mirror';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const answer = (text: string) =>
  convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 't' },
    { type: 'text-delta' as const, id: 't', delta: text },
    { type: 'text-end' as const, id: 't' },
    { type: 'finish' as const, finishReason: 'stop' as const, usage },
  ]);

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  return check();
}

const controllers: AgentController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.destroy?.();
});

async function setup() {
  const model = new MockLanguageModelV2({
    doStream: async () => ({ rawCall: { rawPrompt: null, rawSettings: {} }, warnings: [], stream: answer('Done.') }),
  });
  const agent = new Agent({ id: 'code', name: 'code', instructions: 'test', model });
  const storage = new InMemoryStore();
  const controller = new AgentController({
    id: 'code',
    storage,
    workspace: new Workspace({ name: 'test', skills: ['/tmp/test-skills'] }),
    modes: [{ id: 'default', name: 'Default', default: true, agent }],
  });
  controllers.push(controller);
  await controller.init();
  const log = new InMemoryEventLog();
  const hub = new SessionEventHub(log);
  const memory = (await storage.getStore('memory'))!;

  /** A session whose turns Factory mirrors into its event log, as every Mastra Code session is now. */
  const mirroredSession = async (sessionId: string) => {
    const session = await controller.createSession({
      id: sessionId,
      ownerId: 'o',
      resourceId: sessionId,
      threadId: sessionId,
    });
    mirrorSessionEvents(session, new SessionPublisher(hub, sessionId, { flushMs: 0 }).emit);
    return session;
  };
  const turn = async (session: Awaited<ReturnType<typeof mirroredSession>>, text: string) => {
    await session.sendMessage({ content: text });
    const ended = async () =>
      (await log.list(session.identity.getId())).some(({ event }) => event.type === 'run.ended');
    expect(await until(ended)).toBe(true);
  };
  /** A conversation's first message, stored `minutesAgo` (before Factory mirrored sessions, when > 1). */
  const storedEarlier = async (sessionId: string, minutesAgo: number) => {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await memory.saveThread({
      thread: { id: sessionId, resourceId: sessionId, title: 'Old', createdAt: at, updatedAt: at, metadata: {} },
    });
    await memory.saveMessages({
      messages: [
        {
          id: `${sessionId}-m1`,
          threadId: sessionId,
          resourceId: sessionId,
          role: 'user',
          createdAt: at,
          content: { format: 2, parts: [{ type: 'text', text: 'Fix the login bug' }] },
        },
      ],
    });
  };
  const predates = (sessionId: string) => historyPredatesEventLog({ conversation: controller, events: log, sessionId });
  return { mirroredSession, turn, storedEarlier, predates };
}

describe('historyPredatesEventLog', () => {
  it('says no for a session mirrored from its first turn', async () => {
    const { storedEarlier, mirroredSession, turn, predates } = await setup();
    // Its prompt is stored as its first turn runs (this agent keeps no memory of its own).
    await storedEarlier('fresh', 0);
    await turn(await mirroredSession('fresh'), 'Hello');

    expect(await predates('fresh')).toBe(false);
  });

  it('says no for a session with no conversation yet', async () => {
    const { predates } = await setup();

    expect(await predates('never-started')).toBe(false);
  });

  it('says yes for a conversation from before the log, with nothing logged', async () => {
    const { storedEarlier, predates } = await setup();
    await storedEarlier('old-quiet', 90);

    expect(await predates('old-quiet')).toBe(true);
  });

  it('says yes for a conversation from before the log that carried on once mirrored', async () => {
    const { storedEarlier, mirroredSession, turn, predates } = await setup();
    await storedEarlier('old-active', 90);
    await turn(await mirroredSession('old-active'), 'And now this');

    expect(await predates('old-active')).toBe(true);
  });
});
