// fork(claude-agent): Claude Agent sessions waiting on a person, in the inbox and on the board.
import { InMemoryEventLog, InMemoryInteractionStore, InteractionBroker, SessionEventHub } from '@factory/agent-runtime';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FactoryTransitionService } from '../rules/transition-service.js';
import { LiveSessions } from '../session/live-sessions.js';
import { PendingInteractions, alsoParked } from '../session/pending-interactions.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { FactoryStorageTestSeed } from '../storage/test-utils.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';
import { WorkItemRoutes } from './work-items.js';

const orgUser = { workosId: 'u1', organizationId: 'org1' };
const SESSION = '6f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7';

let seed: FactoryStorageTestSeed;
let PROJECT_ID = '';

function setup() {
  const pending = new PendingInteractions({
    store: new InMemoryInteractionStore(),
    projectOf: async sessionId => (sessionId === SESSION ? { orgId: 'org1', factoryProjectId: PROJECT_ID } : null),
  });
  const broker = new InteractionBroker({ store: pending, hub: new SessionEventHub(new InMemoryEventLog()) });
  // No Mastra Code session is live: the controller holds none.
  const liveSessions = alsoParked(
    new LiveSessions({ onSessionCreated: () => () => {}, onSessionDeleted: () => () => {} }),
    pending,
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, orgUser as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    new WorkItemRoutes({
      auth: fakeRouteAuth(),
      audit: { emit: async () => {} },
      projects: seed.projects,
      workItems: seed.workItems,
      queueHealth: seed.queueHealth,
      transitionService: new FactoryTransitionService({ configVersion: 'factory-config-v1', storage: seed.workItems }),
      liveSessions,
    }).routes(),
  );
  const request = async (method: string, path: string) => app.request(path, { method });
  return { broker, pending, request };
}

beforeEach(async () => {
  seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({ orgId: 'org1', userId: 'u1', input: { name: 'org1 project' } });
  PROJECT_ID = project.id;
});

describe('a Claude Agent session waiting on a person', () => {
  it('shows in the inbox and on its card until it is answered, like a parked Mastra Code run', async () => {
    const { item } = await seed.workItems.upsert({
      orgId: 'org1',
      userId: 'u1',
      factoryProjectId: PROJECT_ID,
      input: { title: 'Ship the login fix', stages: ['intake'], sessions: {}, metadata: {} },
    });
    await seed.workItems.update({
      orgId: 'org1',
      userId: 'u1',
      id: item.id,
      patch: { sessions: { work: { sessionId: SESSION, branch: 'factory/login', threadId: SESSION } } },
    });
    const { broker, pending, request } = setup();
    const answered = broker.request(
      SESSION,
      { kind: 'plan_approval', planPath: '.artifacts/plans/login.md' },
      { callId: 'toolu_plan' },
    );
    await vi.waitFor(() => expect(pending.parkedIn(PROJECT_ID)).toHaveLength(1));
    const suspendedAt = pending.parked(SESSION)!.suspendedAt;

    const inbox = await (await request('GET', `/web/factory/projects/${PROJECT_ID}/attention`)).json();
    expect(inbox).toMatchObject({
      items: [
        {
          kind: 'agent-waiting',
          sessionId: SESSION,
          threadId: SESSION,
          role: 'work',
          toolName: 'submit_plan',
          occurrence: suspendedAt,
          workItemId: item.id,
          detail: 'Plan waiting for review',
          read: false,
          target: { kind: 'thread', sessionId: SESSION, threadId: SESSION },
        },
      ],
      kinds: { 'agent-waiting': { open: 1, unread: 1 } },
    });
    // The board and session lists mark the card's session as waiting on someone.
    const cards = await (await request('GET', `/web/factory/projects/${PROJECT_ID}/work-items`)).json();
    expect(cards.parkedSessionIds).toEqual([SESSION]);

    const receipt = `/web/factory/projects/${PROJECT_ID}/attention/agent-waiting/${SESSION}/${suspendedAt}`;
    expect((await request('POST', `${receipt}/read`)).status).toBe(200);

    const [record] = await broker.listPending({ sessionId: SESSION });
    await broker.resolve(record!.id, { kind: 'plan_approval', action: 'approved' });
    await answered;
    await expect((await request('GET', `/web/factory/projects/${PROJECT_ID}/attention`)).json()).resolves.toMatchObject(
      { items: [], kinds: { 'agent-waiting': { open: 0, unread: 0 } } },
    );
    expect((await request('POST', `${receipt}/archive`)).status).toBe(409);
    const after = await (await request('GET', `/web/factory/projects/${PROJECT_ID}/work-items`)).json();
    expect(after.parkedSessionIds).toEqual([]);
  });
});
