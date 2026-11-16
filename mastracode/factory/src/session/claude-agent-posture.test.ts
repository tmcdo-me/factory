// fork(claude-agent)
import { InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import type { QueryFn } from '@factory/runtime-claude-agent';
import { describe, expect, it, vi } from 'vitest';

import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { claudeAgentCheckoutPosture } from './claude-agent-posture.js';
import { ClaudeAgentSessions } from './claude-agent-sessions.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const now = new Date(0);

/** A fake Claude Code that answers each turn and records the options it was started with. */
function fakeQuery() {
  const options: Record<string, unknown>[] = [];
  const fn: QueryFn = ({ prompt, options: opts }) => {
    options.push(opts as Record<string, unknown>);
    const iterator = (async function* () {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'init', session_id: 'claude-xyz', uuid: 'u' } as never;
        yield { type: 'result', subtype: 'success', session_id: 'claude-xyz', uuid: 'u', usage: {} } as never;
      }
    })();
    return Object.assign(iterator, { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() }) as never;
  };
  return { fn, options };
}

async function bind(storage: WorkItemsStorage, role: string, source: 'issue' | 'pull-request') {
  return storage.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: PROJECT_ID,
    workItem: {
      input: {
        externalSource: { integrationId: 'github', type: source, externalId: `github-${source}:1` },
        title: 'Card',
        stages: ['intake'],
        sessions: {},
        metadata: {},
      },
    },
    role,
    session: { sessionId: 's1', branch: 'factory/card-1', threadId: 's1' },
    resourceId: 's1',
    kickoffKey: `kickoff-${role}-${source}`,
    kickoffMessage: null,
  });
}

/** The session's record, as the agent-sessions domain keeps it across processes. */
function sessionRecord() {
  let runtimeState: unknown;
  return {
    get: async (sessionId: string) => ({
      sessionId,
      runtimeId: 'claude-agent',
      createdAt: now,
      updatedAt: now,
      ...(runtimeState ? { runtimeState } : {}),
    }),
    setRuntimeState: async (_sessionId: string, state: unknown) => {
      runtimeState = state;
    },
    setModel: async () => {},
  };
}

function sessionsFor(
  workItems: Pick<WorkItemsStorage, 'listRunBindingsForSession' | 'get'>,
  record = sessionRecord(),
  checkout?: () => Promise<'trusted' | 'untrusted'>,
) {
  const fake = fakeQuery();
  const log = new InMemoryEventLog();
  const sessions = new ClaudeAgentSessions({
    hub: new SessionEventHub(log),
    sessions: record,
    workspace: async () => ({ cwd: '/sandboxes/s1/repo', env: {} }),
    checkout:
      checkout ??
      claudeAgentCheckoutPosture({
        sessions: { getBySessionId: async () => ({ orgId: 'org-1', factoryProjectId: PROJECT_ID }) },
        workItems,
      }),
    hostEnv: {},
    query: fake.fn,
  });
  const turn = async (text: string) => {
    const ended = (await log.list('s1')).filter(e => e.event.type === 'run.ended').length;
    await sessions.commands().send('s1', { text }, { context: undefined });
    await vi.waitFor(async () =>
      expect((await log.list('s1')).filter(e => e.event.type === 'run.ended')).toHaveLength(ended + 1),
    );
  };
  return { sessions, fake, turn };
}

describe('Claude Agent checkout posture', () => {
  it.each([
    ['a review session', 'review', 'issue'],
    ['a session on a pull request card', 'work', 'pull-request'],
  ] as const)('starts Claude Code with none of the checkout’s own settings for %s', async (_label, role, source) => {
    const { workItems } = await createFactoryStorageForTests();
    await bind(workItems, role, source);
    const { fake, turn } = sessionsFor(workItems);

    await turn('look');

    expect(fake.options[0]!.settingSources).toEqual([]);
  });

  it("loads a trusted card's own settings, and an unbound session's", async () => {
    const { workItems } = await createFactoryStorageForTests();
    const unbound = sessionsFor(workItems);
    await unbound.turn('hi');
    expect(unbound.fake.options[0]!.settingSources).toEqual(['project']);

    await bind(workItems, 'work', 'issue');
    const bound = sessionsFor(workItems);
    await bound.turn('hi');
    expect(bound.fake.options[0]!.settingSources).toEqual(['project']);
  });

  it('fails closed when the card cannot be read', async () => {
    const { workItems } = await createFactoryStorageForTests();
    await bind(workItems, 'work', 'issue');
    const { fake, turn } = sessionsFor({
      listRunBindingsForSession: input => workItems.listRunBindingsForSession(input),
      get: async () => Promise.reject(new Error('db down')),
    });
    await turn('hi');
    expect(fake.options[0]!.settingSources).toEqual([]);
  });

  it('starts Claude Code again, locked down, once its checkout turns untrusted', async () => {
    const { workItems } = await createFactoryStorageForTests();
    const { fake, turn } = sessionsFor(workItems);
    await turn('before');
    // The session now reviews a pull request.
    await bind(workItems, 'review', 'issue');
    await turn('after');

    expect(fake.options.map(options => options.settingSources)).toEqual([['project'], []]);
    expect(fake.options[1]).toMatchObject({ resume: 'claude-xyz' });
  });

  it("stays untrusted once its review's binding has ended: the checkout still holds the pull request", async () => {
    const { workItems } = await createFactoryStorageForTests();
    const review = await bind(workItems, 'review', 'issue');
    const record = sessionRecord();
    const first = sessionsFor(workItems, record);
    await first.turn('review it');
    await workItems.revokeRunBinding({
      orgId: 'org-1',
      factoryProjectId: PROJECT_ID,
      bindingId: review.binding.id,
      revokedAt: new Date(),
    });

    // The next turn, in this process and after a restart, still loads none of the checkout's settings.
    await first.turn('anything else?');
    const restarted = sessionsFor(workItems, record);
    await restarted.turn('back again');
    expect(first.fake.options.map(options => options.settingSources)).toEqual([[]]);
    expect(restarted.fake.options[0]!.settingSources).toEqual([]);

    // Even once its bindings are gone, its record remembers.
    const forgotten = sessionsFor(workItems, record, async () => 'trusted');
    await forgotten.turn('and again');
    expect(forgotten.fake.options[0]!.settingSources).toEqual([]);
  });

  it('counts more than one live binding as untrusted', async () => {
    const posture = claudeAgentCheckoutPosture({
      sessions: { getBySessionId: async () => ({ orgId: 'org-1', factoryProjectId: PROJECT_ID }) },
      workItems: {
        listRunBindingsForSession: async () =>
          [
            { status: 'active', role: 'work', workItemId: 'a' },
            { status: 'active', role: 'plan', workItemId: 'b' },
          ] as never,
        get: async () => ({ externalSource: { type: 'issue' } }) as never,
      },
    });
    expect(await posture('s1')).toBe('untrusted');
  });
});
