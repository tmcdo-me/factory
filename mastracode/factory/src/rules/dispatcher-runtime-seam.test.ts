// fork(claude-agent): board runs whose session runs on another agent runtime (Claude Agent).
import type { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

import { boardRegistryOf, defineBoard, workBoard } from '../boards/index.js';
import type { BoardRegistry } from '../boards/index.js';
import { commitDecisions, createLifecycleTestRegistry } from '../boards/test-utils.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { FactoryDecisionDispatcher } from './dispatcher.js';
import type { FactoryRuntimeSessions, RuntimeKickoff, RuntimeRunEnd } from './runtime-sessions.js';
import { FactoryTransitionService } from './transition-service.js';
import type { FactoryCommitDecision } from './types.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

/** A runtime whose runs end however the test says; it records what the dispatcher asked of it. */
function fakeRuntime(
  options: {
    end?: RuntimeRunEnd;
    landed?: string[];
    onKickoff?: () => Promise<void>;
    /**
     * A run is in flight: `parked`, a board run waiting on a person; `person`, a person's own turn
     * waiting on their answer; `busy`, any run that ends soon; `stuck`, one that never ends.
     */
    inFlight?: 'parked' | 'person' | 'busy' | 'stuck';
    runs?: (sessionId: string) => Promise<boolean>;
  } = {},
) {
  let running = options.inFlight !== undefined;
  const kickoffs: { sessionId: string; kickoff: RuntimeKickoff; user: unknown }[] = [];
  const messages: { sessionId: string; text: string; source: string; wake: boolean }[] = [];
  const calls: string[] = [];
  const runtime: FactoryRuntimeSessions = {
    runs: vi.fn(options.runs ?? (async sessionId => sessionId === 'session-1')),
    hasRun: vi.fn(async (_sessionId, runId) => options.landed?.includes(runId) ?? false),
    isRunning: vi.fn(() => running),
    parkedBoardRun: vi.fn(async () => running && options.inFlight === 'parked'),
    awaitsPerson: vi.fn(async () => running && (options.inFlight === 'parked' || options.inFlight === 'person')),
    idle: vi.fn(async () => {
      calls.push('idle');
      if (options.inFlight === 'stuck' || options.inFlight === 'person') await new Promise(() => {});
      running = false;
    }),
    kickoff: vi.fn(async (sessionId: string, kickoff: RuntimeKickoff, requestContext: RequestContext) => {
      calls.push('kickoff');
      kickoffs.push({ sessionId, kickoff, user: requestContext.get('user') });
      await options.onKickoff?.();
      return { ended: Promise.resolve(options.end ?? { reason: 'complete' }) };
    }),
    message: vi.fn(async (sessionId, message) => {
      messages.push({ sessionId, ...message });
    }),
    abort: vi.fn(async () => {
      calls.push('abort');
      running = false;
    }),
  };
  return { runtime, kickoffs, messages, calls };
}

/** The agent controller still holds the session (routes read it), but nothing may run on it. */
function idleController() {
  const sendSignal = vi.fn();
  const sendNotificationSignal = vi.fn();
  return {
    controller: {
      getSession: vi.fn(async () => ({ sendSignal, sendNotificationSignal })),
      listActiveThreadRuns: () => [],
    },
    sendSignal,
    sendNotificationSignal,
  };
}

async function cardWithDecision(
  storage: WorkItemsStorage,
  decision: FactoryCommitDecision,
  options: { stage?: string; boards?: BoardRegistry; description?: string } = {},
) {
  const stage = options.stage ?? 'execute';
  const item = (
    await storage.upsert({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: PROJECT_ID,
      input: {
        externalSource: { integrationId: 'github', type: 'issue', externalId: 'github-issue:1' },
        title: 'Fix issue',
        stages: ['intake'],
        sessions: {},
        metadata: { authorTrusted: true },
        ...(options.description ? { description: options.description } : {}),
      },
    })
  ).item;
  // The card's session: Claude Agent sessions are bound on their own thread and resource.
  await storage.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: PROJECT_ID,
    workItem: {
      id: item.id,
      input: { title: 'Fix issue', stages: ['intake'], sessions: {}, metadata: {} },
    },
    role: 'work',
    session: { sessionId: 'session-1', branch: 'factory/issue-1', threadId: 'session-1' },
    resourceId: 'session-1',
    kickoffKey: `kickoff-${item.id}`,
    kickoffMessage: null,
  });
  const committed = await commitDecisions(storage, {
    factoryProjectId: PROJECT_ID,
    workItemId: item.id,
    stage,
    decisions: [decision],
    actorId: 'user-1',
  });
  expect(committed.status).toBe('committed');
  // A person started the card, so its runs need no further approval.
  const card = await storage.get({ orgId: 'org-1', id: item.id });
  await storage.commitTransition({
    orgId: 'org-1',
    factoryProjectId: PROJECT_ID,
    workItemId: item.id,
    expectedRevision: card!.revision,
    destinationStage: stage,
    actorId: 'user-1',
    ingress: { identity: `arm-${item.id}`, triggerType: 'human', transitionId: `arm-${item.id}` },
    configVersion: 'rules-v1',
    causalChain: [],
    evaluation: { outcome: 'accepted', decisions: [] },
    autonomy: 'arm',
  });
  const boards = options.boards ?? createLifecycleTestRegistry();
  return { item, transitionService: new FactoryTransitionService({ storage, configVersion: 'rules-v1', boards }) };
}

function dispatcherFor(
  storage: WorkItemsStorage,
  transitionService: FactoryTransitionService,
  runtime: FactoryRuntimeSessions,
  boards: BoardRegistry = createLifecycleTestRegistry(),
  options: { skillCompletionObservationTimeoutMs?: number } = {},
) {
  const { controller, sendSignal, sendNotificationSignal } = idleController();
  const dispatcher = new FactoryDecisionDispatcher({
    controller: controller as never,
    transitionService,
    storage,
    boards,
    ownerId: 'worker-1',
    runtimeSessions: runtime,
    ...options,
  });
  return { dispatcher, sendSignal, sendNotificationSignal };
}

/** The run's own move: what a working phase's run does before it ends (its exit tool, a transition). */
const workOnCard = (storage: WorkItemsStorage, id: string) => async () => {
  const card = await storage.get({ orgId: 'org-1', id });
  await storage.update({
    orgId: 'org-1',
    id,
    userId: 'agent:binding',
    patch: { metadata: { worked: true } },
    expectedRevision: card!.revision,
  });
};

const decisionOf = async (storage: WorkItemsStorage, key: string) =>
  (await storage.listDeferredDecisions('org-1', PROJECT_ID)).find(row => row.idempotencyKey === key);

describe('FactoryDecisionDispatcher on another agent runtime', () => {
  it("kicks a phase's skill off through the runtime, as the session's owner, once its open run ends", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { item, transitionService } = await cardWithDecision(
      storage,
      {
        type: 'invokeSkill',
        role: 'work',
        skillName: 'factory-build',
        arguments: 'card 1',
        precedingMessage: 'Moved to Building.',
        idempotencyKey: 'build',
      },
      { description: 'Make the build green.' },
    );
    const { runtime, kickoffs, calls } = fakeRuntime({ onKickoff: workOnCard(storage, item.id) });
    const { dispatcher, sendSignal, sendNotificationSignal } = dispatcherFor(storage, transitionService, runtime);

    await dispatcher.runOnce(new Date());

    const decision = await decisionOf(storage, 'build');
    expect(decision?.lastError).toBeNull();
    expect(decision).toMatchObject({ status: 'succeeded' });
    expect(kickoffs).toEqual([
      {
        sessionId: 'session-1',
        kickoff: {
          runId: decision!.id,
          skill: { name: 'factory-build', arguments: 'card 1' },
          description: 'Make the build green.',
          preface: 'Moved to Building.',
        },
        user: { workosId: 'user-1', organizationId: 'org-1' },
      },
    ]);
    expect(calls).toEqual(['idle', 'kickoff']);
    // Nothing ran on the Mastra Code side of the session.
    expect(sendSignal).not.toHaveBeenCalled();
    expect(sendNotificationSignal).not.toHaveBeenCalled();
  });

  it.each([
    [{ reason: 'error', error: 'Claude Code exited' } as const, /Factory skill run/],
    [{ reason: 'aborted' } as const, /was aborted before it finished/],
  ])('fails the decision for a retry when the run ends %o', async (end, message) => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(storage, {
      type: 'invokeSkill',
      role: 'work',
      prompt: 'Continue.',
      idempotencyKey: 'run',
    });
    const { runtime } = fakeRuntime({ end });
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime);

    await dispatcher.runOnce(new Date());

    const decision = await decisionOf(storage, 'run');
    expect(decision).toMatchObject({ status: 'retry', attempts: 1 });
    expect(decision?.lastError).toMatch(message);
  });

  it('does not kick off again when the kickoff already landed', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(storage, {
      type: 'invokeSkill',
      role: 'work',
      prompt: 'Continue.',
      idempotencyKey: 'landed',
    });
    const id = (await decisionOf(storage, 'landed'))!.id;
    const { runtime, kickoffs } = fakeRuntime({ landed: [id] });
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime);

    await dispatcher.runOnce(new Date());

    expect(kickoffs).toEqual([]);
    expect(await decisionOf(storage, 'landed')).toMatchObject({ status: 'succeeded' });
  });

  it('fails a working run that ends without finishing its phase, and lets the board approve its plans', async () => {
    const board = defineBoard({
      id: 'work',
      name: 'Work',
      initialPhase: 'intake',
      sourceClosed: workBoard.sourceClosed,
      tools: workBoard.tools,
      phases: {
        ...workBoard.phases,
        planning: { ...workBoard.phases.planning, exitTool: { id: 'submit_plan', autoApprove: true } },
      },
    });
    const boards = boardRegistryOf([board]);
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(
      storage,
      { type: 'invokeSkill', role: 'work', skillName: 'factory-plan', idempotencyKey: 'plan' },
      { stage: 'planning', boards },
    );
    const { runtime, kickoffs } = fakeRuntime();
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, boards);

    await dispatcher.runOnce(new Date());

    expect((await decisionOf(storage, 'plan'))?.lastError).toMatch(/ended before completing the working phase/);
    // The board approves up to three plans itself; then one waits for a person.
    const approve = kickoffs[0]!.kickoff.autoApprovePlan!;
    expect([approve(), approve(), approve(), approve()]).toEqual([true, true, true, false]);
  });

  it('completes a working run parked on a person, as a suspended Mastra Code run does', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(
      storage,
      { type: 'invokeSkill', role: 'work', skillName: 'factory-plan', idempotencyKey: 'plan' },
      { stage: 'planning', boards: boardRegistryOf([workBoard]) },
    );
    const { runtime, kickoffs } = fakeRuntime({ end: { reason: 'awaiting_interaction' } });
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, boardRegistryOf([workBoard]));

    await dispatcher.runOnce(new Date());

    expect(await decisionOf(storage, 'plan')).toMatchObject({ status: 'succeeded' });
    // Work's plans wait for a person.
    expect(kickoffs[0]!.kickoff.autoApprovePlan).toBeUndefined();
  });

  it('completes a working run that worked the card', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { item, transitionService } = await cardWithDecision(
      storage,
      { type: 'invokeSkill', role: 'work', skillName: 'factory-plan', idempotencyKey: 'plan' },
      { stage: 'planning', boards: boardRegistryOf([workBoard]) },
    );
    const { runtime } = fakeRuntime({ onKickoff: workOnCard(storage, item.id) });
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, boardRegistryOf([workBoard]));

    await dispatcher.runOnce(new Date());

    expect(await decisionOf(storage, 'plan')).toMatchObject({ status: 'succeeded' });
  });

  it("sends a rule's message into the runtime session: waking it, or for its next turn", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(storage, {
      type: 'sendMessage',
      role: 'work',
      message: 'Rebase onto main.',
      idempotencyKey: 'wake',
    });
    await commitDecisions(storage, {
      factoryProjectId: PROJECT_ID,
      workItemId: (await storage.listRunBindings('org-1', PROJECT_ID))[0]!.workItemId,
      stage: 'execute',
      decisions: [
        { type: 'sendMessage', role: 'work', message: 'FYI.', idleBehavior: 'persist', idempotencyKey: 'persist' },
      ],
      actorId: 'user-1',
    });
    const { runtime, messages } = fakeRuntime();
    const { dispatcher, sendNotificationSignal } = dispatcherFor(storage, transitionService, runtime);

    await dispatcher.runOnce(new Date());

    expect(messages).toEqual(
      expect.arrayContaining([
        { sessionId: 'session-1', text: 'Rebase onto main.', source: 'rule-message', wake: true },
        { sessionId: 'session-1', text: 'FYI.', source: 'rule-message', wake: false },
      ]),
    );
    expect(sendNotificationSignal).not.toHaveBeenCalled();
    expect(await decisionOf(storage, 'wake')).toMatchObject({ status: 'succeeded' });
  });

  it("points the session at activity on its card's source; only a trusted author wakes it", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const activity = (author: string, authorTrusted: boolean) =>
      ({
        type: 'signalActivity',
        idempotencyKey: `comment-${author}`,
        event: 'work_item.commented',
        reference: 'acme/repo#1',
        url: 'https://github.com/acme/repo/issues/1#issuecomment-1',
        author,
        authorTrusted,
      }) as const;
    const { item, transitionService } = await cardWithDecision(storage, activity('ann', true));
    await commitDecisions(storage, {
      factoryProjectId: PROJECT_ID,
      workItemId: item.id,
      stage: 'execute',
      decisions: [activity('mallory', false)],
      actorId: 'user-1',
    });
    const { runtime, messages } = fakeRuntime();
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime);

    await dispatcher.runOnce(new Date());

    expect(messages).toEqual(
      expect.arrayContaining([
        {
          sessionId: 'session-1',
          text: 'New comment by @ann on acme/repo#1: https://github.com/acme/repo/issues/1#issuecomment-1',
          source: 'source-activity',
          wake: true,
        },
        {
          sessionId: 'session-1',
          text: 'New comment by @mallory (untrusted author) on acme/repo#1: https://github.com/acme/repo/issues/1#issuecomment-1',
          source: 'source-activity',
          wake: false,
        },
      ]),
    );
  });

  it("drops a run parked on a person before the next phase's kickoff, instead of queueing behind it", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { item, transitionService } = await cardWithDecision(storage, {
      type: 'invokeSkill',
      role: 'work',
      prompt: 'Continue.',
      idempotencyKey: 'next',
    });
    const parked = fakeRuntime({ inFlight: 'parked', onKickoff: workOnCard(storage, item.id) });
    await dispatcherFor(storage, transitionService, parked.runtime).dispatcher.runOnce(new Date());
    expect(parked.calls).toEqual(['abort', 'idle', 'kickoff']);
    expect(await decisionOf(storage, 'next')).toMatchObject({ status: 'succeeded' });
  });

  it("waits for a person's turn in flight, but only so long, then hands the decision back", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(storage, {
      type: 'invokeSkill',
      role: 'work',
      prompt: 'Continue.',
      idempotencyKey: 'stuck',
    });
    const stuck = fakeRuntime({ inFlight: 'stuck' });
    const { dispatcher } = dispatcherFor(storage, transitionService, stuck.runtime, undefined, {
      skillCompletionObservationTimeoutMs: 20,
    });

    await dispatcher.runOnce(new Date());

    expect(stuck.calls).toEqual(['idle']);
    expect(await decisionOf(storage, 'stuck')).toMatchObject({ status: 'retry' });
    expect((await decisionOf(storage, 'stuck'))?.lastError).toMatch(/still has a run in flight/);
  });

  it('kicks a pending start off once, after the run in flight, and never approves plans for it', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const item = (
      await storage.upsert({
        orgId: 'org-1',
        userId: 'user-1',
        factoryProjectId: PROJECT_ID,
        input: { title: 'Fix issue', stages: ['execute'], sessions: {}, metadata: {} },
      })
    ).item;
    await storage.prepareRunStart({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: PROJECT_ID,
      workItem: { id: item.id, input: { title: 'Fix issue', stages: ['execute'], sessions: {}, metadata: {} } },
      role: 'work',
      session: { sessionId: 'session-1', branch: 'factory/issue-1', threadId: 'session-1' },
      resourceId: 'session-1',
      kickoffKey: 'start-1',
      kickoffMessage: 'Start work on this issue.',
    });
    const transitionService = new FactoryTransitionService({ storage, configVersion: 'rules-v1' });
    const busy = fakeRuntime({ inFlight: 'busy' });
    await dispatcherFor(storage, transitionService, busy.runtime).dispatcher.runOnce(new Date());
    expect(busy.calls).toEqual(['idle', 'kickoff']);
    expect(busy.kickoffs[0]!.kickoff).toMatchObject({
      runId: 'factory-kickoff:start-1:1',
      prompt: 'Start work on this issue.',
    });
    expect(busy.kickoffs[0]!.kickoff.autoApprovePlan).toBeUndefined();
  });

  it('leaves a session that runs on Mastra Code on the agent controller, as before', async () => {
    const runs = async () => false;
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(storage, {
      type: 'sendMessage',
      role: 'work',
      message: 'Rebase onto main.',
      idempotencyKey: 'mastra',
    });
    const sendNotificationSignal = vi.fn(async () => ({
      persisted: Promise.resolve(),
      accepted: Promise.resolve({ action: 'deliver' }),
    }));
    const session = {
      thread: { requireId: () => 'session-1', switch: vi.fn() },
      state: { get: () => ({}) },
      identity: { getId: () => 'session-1', getOwnerId: () => 'user-1' },
      model: { get: () => 'openai/gpt-5.5' },
      getWorkspace: () => undefined,
      sendNotificationSignal,
    };
    const seam = fakeRuntime({ runs });
    const dispatcher = new FactoryDecisionDispatcher({
      controller: { getSession: vi.fn(async () => session), listActiveThreadRuns: () => [] } as never,
      transitionService,
      storage,
      boards: createLifecycleTestRegistry(),
      ownerId: 'worker-1',
      runtimeSessions: seam.runtime,
    });

    await dispatcher.runOnce(new Date());

    expect((await decisionOf(storage, 'mastra'))?.lastError ?? null).toBeNull();
    expect(sendNotificationSignal).toHaveBeenCalledTimes(1);
    expect(seam.messages).toEqual([]);
    expect(await decisionOf(storage, 'mastra')).toMatchObject({ status: 'succeeded' });
  });

  it("never guesses a runtime it can't read: no Mastra Code kickoff, no message, and a retry", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { item, transitionService } = await cardWithDecision(storage, {
      type: 'invokeSkill',
      role: 'work',
      prompt: 'Continue.',
      idempotencyKey: 'unknown',
    });
    await commitDecisions(storage, {
      factoryProjectId: PROJECT_ID,
      workItemId: item.id,
      stage: 'execute',
      decisions: [{ type: 'sendMessage', role: 'work', message: 'FYI.', idempotencyKey: 'unknown-message' }],
      actorId: 'user-1',
    });
    const seam = fakeRuntime({ runs: async () => Promise.reject(new Error('db down')) });
    const { dispatcher, sendSignal, sendNotificationSignal } = dispatcherFor(storage, transitionService, seam.runtime);

    await dispatcher.runOnce(new Date());

    for (const key of ['unknown', 'unknown-message']) {
      const decision = await decisionOf(storage, key);
      expect(decision).toMatchObject({ status: 'retry', failureCode: 'session_unavailable' });
    }
    expect(sendSignal).not.toHaveBeenCalled();
    expect(sendNotificationSignal).not.toHaveBeenCalled();
    expect(seam.kickoffs).toEqual([]);
    expect(seam.messages).toEqual([]);
  });

  it("waits for a person's own parked turn instead of aborting it, then hands the decision back", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await cardWithDecision(storage, {
      type: 'invokeSkill',
      role: 'work',
      prompt: 'Continue.',
      idempotencyKey: 'behind-person',
    });
    const person = fakeRuntime({ inFlight: 'person' });
    const { dispatcher } = dispatcherFor(storage, transitionService, person.runtime, undefined, {
      skillCompletionObservationTimeoutMs: 20,
    });

    await dispatcher.runOnce(new Date());

    expect(person.calls).toEqual(['idle']);
    expect(await decisionOf(storage, 'behind-person')).toMatchObject({ status: 'retry' });
  });
});
