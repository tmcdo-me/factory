// fork(claude-agent): the run lifecycle of board runs on another agent runtime (Claude Agent): phase
// goals re-kicked until met or spent, and the open-run ledger and run records.
import type { RequestContext } from '@mastra/core/request-context';
import type { GoalObjectiveRecord } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { boardRegistryOf, workBoard } from '../boards/index.js';
import { commitDecisions } from '../boards/test-utils.js';
import { FACTORY_OPEN_RUNS_SETTING } from '../session/run-audit.js';
import type { FactoryOpenRun } from '../session/run-audit.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { FactoryDecisionDispatcher } from './dispatcher.js';
import { PHASE_GOAL_METADATA_KEY } from './phase-goal.js';
import type { FactoryRuntimeSessions, RuntimeKickoff, RuntimeRunEnd, RuntimeThreadState } from './runtime-sessions.js';
import { FactoryTransitionService } from './transition-service.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OBJECTIVE = 'Done when the plan is built, its gates pass, and the card moved on.';
const boards = boardRegistryOf([workBoard]);

/** Mastra's `threadState`, in memory. */
function threadState() {
  const values = new Map<string, unknown>();
  const key = (threadId: string, type: string) => `${threadId} ${type}`;
  const store: RuntimeThreadState = {
    getState: async <T>({ threadId, type }: { threadId: string; type: string }) =>
      structuredClone(values.get(key(threadId, type))) as T | undefined,
    setState: async ({ threadId, type, value }) => {
      values.set(key(threadId, type), structuredClone(value));
    },
  };
  return {
    store,
    goal: () => store.getState<GoalObjectiveRecord>({ threadId: 'session-1', type: 'goal' }),
    ledger: async () =>
      (await store.getState<FactoryOpenRun[]>({ threadId: 'session-1', type: FACTORY_OPEN_RUNS_SETTING })) ?? [],
  };
}

type Turn = (kickoff: RuntimeKickoff) => Promise<RuntimeRunEnd> | RuntimeRunEnd;

/** A runtime whose turns end as the test scripts them, one per kickoff; past the script, each completes. */
function scriptedRuntime(turns: Turn[]) {
  let running = false;
  const kickoffs: RuntimeKickoff[] = [];
  const runtime: FactoryRuntimeSessions = {
    runs: async sessionId => sessionId === 'session-1',
    hasRun: async () => false,
    isRunning: () => running,
    parkedBoardRun: async () => false,
    awaitsPerson: async () => false,
    idle: async () => {},
    kickoff: vi.fn(async (_sessionId: string, kickoff: RuntimeKickoff, _requestContext: RequestContext) => {
      const turn = turns[kickoffs.length] ?? (() => ({ reason: 'complete' as const }));
      kickoffs.push(kickoff);
      running = true;
      const ended = Promise.resolve(turn(kickoff)).finally(() => {
        running = false;
      });
      return { ended };
    }),
    message: async () => {},
    abort: async () => {},
  };
  return { runtime, kickoffs };
}

function auditLog() {
  const records: { action: string; metadata: Record<string, unknown>; actorType: string; actorId: string }[] = [];
  return {
    records,
    audit: {
      record: vi.fn(async (input: (typeof records)[number]) => {
        records.push(input);
        return true;
      }),
    },
  };
}

/** A card in Building with its decision committed, bound to the Claude Agent session `session-1`. */
async function building(
  storage: WorkItemsStorage,
  goal: { objective: string; maxRuns?: number } = { objective: OBJECTIVE, maxRuns: 3 },
) {
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
      },
    })
  ).item;
  await storage.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: PROJECT_ID,
    workItem: { id: item.id, input: { title: 'Fix issue', stages: ['intake'], sessions: {}, metadata: {} } },
    role: 'work',
    session: { sessionId: 'session-1', branch: 'factory/issue-1', threadId: 'session-1' },
    resourceId: 'session-1',
    kickoffKey: `kickoff-${item.id}`,
    kickoffMessage: null,
  });
  const committed = await commitDecisions(storage, {
    factoryProjectId: PROJECT_ID,
    workItemId: item.id,
    stage: 'execute',
    decisions: [{ type: 'invokeSkill', role: 'work', skillName: 'factory-build', goal, idempotencyKey: 'build' }],
    actorId: 'user-1',
  });
  expect(committed.status).toBe('committed');
  const card = await storage.get({ orgId: 'org-1', id: item.id });
  await storage.commitTransition({
    orgId: 'org-1',
    factoryProjectId: PROJECT_ID,
    workItemId: item.id,
    expectedRevision: card!.revision,
    destinationStage: 'execute',
    actorId: 'user-1',
    ingress: { identity: `arm-${item.id}`, triggerType: 'human', transitionId: `arm-${item.id}` },
    configVersion: 'rules-v1',
    causalChain: [],
    evaluation: { outcome: 'accepted', decisions: [] },
    autonomy: 'arm',
  });
  const transitionService = new FactoryTransitionService({ storage, configVersion: 'rules-v1', boards });
  /** The run's own move out of Building, as `factory_transition_work_item` makes it. */
  const moveOn = async () => {
    const current = await storage.get({ orgId: 'org-1', id: item.id });
    const moved = await transitionService.transition({
      orgId: 'org-1',
      factoryProjectId: PROJECT_ID,
      workItemId: item.id,
      board: 'work',
      stage: 'done',
      expectedRevision: current!.revision,
      actor: { type: 'agent', id: 'agent:session-1' },
      ingress: { type: 'agent', identity: `move-${item.id}` },
      cause: 'agent_tool',
    } as never);
    expect(moved.status).toBe('accepted');
  };
  return { item, transitionService, moveOn };
}

function dispatcherFor(
  storage: WorkItemsStorage,
  transitionService: FactoryTransitionService,
  runtime: FactoryRuntimeSessions,
  options: { state?: RuntimeThreadState; audit?: ReturnType<typeof auditLog>['audit'] } = {},
) {
  const sendSignal = vi.fn();
  return {
    sendSignal,
    dispatcher: new FactoryDecisionDispatcher({
      controller: { getSession: vi.fn(async () => ({ sendSignal })), listActiveThreadRuns: () => [] } as never,
      transitionService,
      storage,
      boards,
      ownerId: 'worker-1',
      runtimeSessions: runtime,
      ...(options.state ? { runtimeThreadState: async () => options.state } : {}),
      ...(options.audit ? { audit: options.audit as never } : {}),
    }),
  };
}

const decisionOf = async (storage: WorkItemsStorage) =>
  (await storage.listDeferredDecisions('org-1', PROJECT_ID)).find(row => row.idempotencyKey === 'build');

describe('phase goals on another agent runtime', () => {
  it("re-kicks a run until it moves the card on, each turn judged by Factory, and holds the goal as Mastra Code's", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { item, transitionService, moveOn } = await building(storage);
    const state = threadState();
    const { runtime, kickoffs } = scriptedRuntime([
      () => ({ reason: 'complete' }),
      () => ({ reason: 'complete' }),
      async () => {
        await moveOn();
        return { reason: 'complete' };
      },
    ]);
    const { dispatcher, sendSignal } = dispatcherFor(storage, transitionService, runtime, { state: state.store });

    await dispatcher.runOnce(new Date());

    const decision = await decisionOf(storage);
    expect(decision?.lastError).toBeNull();
    expect(decision).toMatchObject({ status: 'succeeded' });
    // The kickoff carries the goal; each re-kick goes on in the same run with Factory's verdict.
    expect(kickoffs[0]).toMatchObject({
      runId: decision!.id,
      skill: { name: 'factory-build' },
      goal: { objective: OBJECTIVE, maxRuns: 3 },
    });
    expect(kickoffs.slice(1).map(kickoff => kickoff.runId)).toEqual([
      `${decision!.id}:goal:1`,
      `${decision!.id}:goal:2`,
    ]);
    expect(kickoffs[1]).not.toHaveProperty('skill');
    expect(kickoffs[1]!.continuation).toMatch(/^\[Goal attempt 1\/3\] The goal is not yet complete/);
    expect(kickoffs[1]!.continuation).toContain(`Continue working toward the goal: ${OBJECTIVE}`);
    expect(kickoffs[2]!.continuation).toMatch(/^\[Goal attempt 2\/3\]/);
    // The same record Mastra Code's objective API keeps, under the decision's id, and the card's stamp.
    expect(await state.goal()).toMatchObject({
      id: decision!.id,
      objective: OBJECTIVE,
      status: 'done',
      runsUsed: 3,
      maxRuns: 3,
    });
    expect((await storage.get({ orgId: 'org-1', id: item.id }))?.metadata?.[PHASE_GOAL_METADATA_KEY]).toEqual({
      phaseKey: 'execute',
      goalId: decision!.id,
      threadId: 'session-1',
      sessionId: 'session-1',
    });
    // Nothing ran on the agent controller.
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('parks a goal whose runs are spent and fails the run as incomplete; a retry runs once and stops', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await building(storage, { objective: OBJECTIVE, maxRuns: 2 });
    const state = threadState();
    const { runtime, kickoffs } = scriptedRuntime([]);
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, { state: state.store });

    await dispatcher.runOnce(new Date());

    const first = await decisionOf(storage);
    expect(first).toMatchObject({ status: 'retry', failureCode: 'run_incomplete' });
    expect(kickoffs).toHaveLength(2);
    expect(await state.goal()).toMatchObject({
      status: 'paused',
      runsUsed: 2,
      pausedReason: expect.stringContaining('Ran out of evaluation budget (2 runs)'),
    });

    // The retry keeps the goal and its count, as Mastra Code's does: its kickoff runs, and nothing more.
    await dispatcher.runOnce(new Date(Date.now() + 60_000));

    expect(kickoffs).toHaveLength(3);
    expect(kickoffs[2]).toMatchObject({ skill: { name: 'factory-build' } });
    expect(await decisionOf(storage)).toMatchObject({ status: 'failed', failureCode: 'run_incomplete' });
    expect(await state.goal()).toMatchObject({ id: first!.id, status: 'paused', runsUsed: 2 });
  });

  it('stops re-kicking while the run waits on a person, and goes on once they answer', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService, moveOn } = await building(storage);
    const state = threadState();
    const { audit, records } = auditLog();
    let answer!: (end: RuntimeRunEnd) => void;
    const resumed = new Promise<RuntimeRunEnd>(resolve => (answer = resolve));
    const { runtime, kickoffs } = scriptedRuntime([
      () => ({ reason: 'awaiting_interaction', resumed }),
      async () => {
        await moveOn();
        return { reason: 'complete' };
      },
    ]);
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, { state: state.store, audit });

    await dispatcher.runOnce(new Date());

    // Parked, as a suspended Mastra Code run: the decision is done, the goal still active, the run open.
    expect(await decisionOf(storage)).toMatchObject({ status: 'succeeded' });
    expect(kickoffs).toHaveLength(1);
    expect(await state.goal()).toMatchObject({ status: 'active', runsUsed: 0 });
    expect(await state.ledger()).toHaveLength(1);

    answer({ reason: 'complete' });
    await vi.waitFor(async () => expect(await state.goal()).toMatchObject({ status: 'done', runsUsed: 2 }));
    expect(kickoffs[1]).toMatchObject({ continuation: expect.stringMatching(/^\[Goal attempt 1\/3\]/) });
    await vi.waitFor(async () => expect(await state.ledger()).toEqual([]));
    expect(records.map(record => [record.action, record.metadata.reason])).toEqual([
      ['factory.run.started', undefined],
      ['factory.run.ended', 'complete'],
    ]);
  });

  it('fails a run that errors without counting the turn against its goal', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await building(storage);
    const state = threadState();
    const { runtime, kickoffs } = scriptedRuntime([() => ({ reason: 'error', error: 'provider down' })]);
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, { state: state.store });

    await dispatcher.runOnce(new Date());

    expect(await decisionOf(storage)).toMatchObject({ status: 'retry', failureCode: 'run_failed' });
    expect(kickoffs).toHaveLength(1);
    expect(await state.goal()).toMatchObject({ status: 'active', runsUsed: 0 });
  });

  it('runs once, as before, where nothing holds goals', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService } = await building(storage);
    const { runtime, kickoffs } = scriptedRuntime([]);
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime);

    await dispatcher.runOnce(new Date());

    expect(kickoffs).toHaveLength(0);
    expect(await decisionOf(storage)).toMatchObject({ status: 'failed', failureCode: 'run_configuration_invalid' });
  });
});

describe('run records on another agent runtime', () => {
  it('keeps the run on the open-run ledger from its kickoff to its end, and records both, with its usage', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { item, transitionService, moveOn } = await building(storage);
    const state = threadState();
    const { audit, records } = auditLog();
    let ledgerMidRun: FactoryOpenRun[] = [];
    const { runtime } = scriptedRuntime([
      async () => {
        // While the turn runs, the ledger names it as this dispatcher's.
        await vi.waitFor(async () => expect(await state.ledger()).toHaveLength(1));
        ledgerMidRun = await state.ledger();
        return { reason: 'complete', usage: [{ inputTokens: 10, outputTokens: 5, cachedInputTokens: 90 }] };
      },
      async () => {
        await moveOn();
        return { reason: 'complete', usage: [{ inputTokens: 2, outputTokens: 1 }] };
      },
    ]);
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, { state: state.store, audit });

    await dispatcher.runOnce(new Date());

    const decision = await decisionOf(storage);
    expect(ledgerMidRun).toEqual([
      expect.objectContaining({
        kickoffId: decision!.id,
        bindingId: expect.any(String),
        role: 'work',
        ownerId: 'worker-1',
        workItemId: item.id,
        workItemName: 'Fix issue',
        sessionId: 'session-1',
        threadId: 'session-1',
        startedAt: expect.any(Number),
      }),
    ]);
    expect(await state.ledger()).toEqual([]);
    // One run, re-kicks and all, as Mastra Code's goal loop is one run.
    expect(records.map(record => record.action)).toEqual(['factory.run.started', 'factory.run.ended']);
    expect(records[0]).toMatchObject({ actorType: 'system', actorId: 'factory-rule-dispatcher' });
    expect(records[1]!.metadata).toMatchObject({
      kickoffId: decision!.id,
      reason: 'complete',
      startedAt: expect.any(Number),
      usage: {
        status: 'recorded',
        stepCount: 2,
        totals: { promptTokens: 102, completionTokens: 6, totalTokens: 108, cachedInputTokens: 90 },
      },
    });
  });

  it("hands the decision back while another dispatcher's run is live on the ledger, and sweeps a dead one's", async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const { transitionService, moveOn } = await building(storage);
    const state = threadState();
    const { audit, records } = auditLog();
    const [binding] = await storage.listRunBindings('org-1', PROJECT_ID);
    const entry = (kickoffId: string, heartbeatAt: number): FactoryOpenRun => ({
      kickoffId,
      bindingId: binding!.id,
      role: 'work',
      startedBy: 'user-1',
      orgId: 'org-1',
      factoryProjectId: PROJECT_ID,
      workItemId: binding!.workItemId,
      sessionId: 'session-1',
      threadId: 'session-1',
      branch: 'factory/issue-1',
      ownerId: 'worker-2',
      heartbeatAt,
    });
    await state.store.setState({
      threadId: 'session-1',
      type: FACTORY_OPEN_RUNS_SETTING,
      value: [entry('live', Date.now())],
    });
    const { runtime, kickoffs } = scriptedRuntime([
      async () => {
        await moveOn();
        return { reason: 'complete' };
      },
    ]);
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, { state: state.store, audit });

    await dispatcher.runOnce(new Date());
    expect(kickoffs).toHaveLength(0);
    expect(await decisionOf(storage)).toMatchObject({ status: 'retry', failureCode: 'session_unavailable' });

    // The other dispatcher died: its entry is stale, so the run starts, and the entry ends with this one.
    await state.store.setState({
      threadId: 'session-1',
      type: FACTORY_OPEN_RUNS_SETTING,
      value: [entry('orphan', Date.now() - 60_000)],
    });
    await dispatcher.runOnce(new Date(Date.now() + 60_000));

    expect(kickoffs).toHaveLength(1);
    expect(await decisionOf(storage)).toMatchObject({ status: 'succeeded' });
    expect(await state.ledger()).toEqual([]);
    expect(
      records
        .filter(record => record.action === 'factory.run.ended')
        .map(record => [record.metadata.kickoffId, record.metadata.reason]),
    ).toEqual([
      [kickoffs[0]!.runId, 'complete'],
      ['orphan', 'aborted'],
    ]);
  });

  it('records a pending start as its starter’s run', async () => {
    const { workItems: storage } = await createFactoryStorageForTests();
    const item = (
      await storage.upsert({
        orgId: 'org-1',
        userId: 'user-1',
        factoryProjectId: PROJECT_ID,
        input: { title: 'Fix issue', stages: ['intake'], sessions: {}, metadata: {} },
      })
    ).item;
    await storage.prepareRunStart({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: PROJECT_ID,
      workItem: { id: item.id, input: { title: 'Fix issue', stages: ['intake'], sessions: {}, metadata: {} } },
      role: 'work',
      session: { sessionId: 'session-1', branch: 'factory/issue-1', threadId: 'session-1' },
      resourceId: 'session-1',
      kickoffKey: 'start-1',
      kickoffMessage: 'Start work on this issue.',
    });
    const state = threadState();
    const { audit, records } = auditLog();
    const { runtime } = scriptedRuntime([]);
    const transitionService = new FactoryTransitionService({ storage, configVersion: 'rules-v1', boards });
    const { dispatcher } = dispatcherFor(storage, transitionService, runtime, { state: state.store, audit });

    await dispatcher.runOnce(new Date());

    expect(records.map(record => [record.action, record.actorId])).toEqual([
      ['factory.run.started', 'user-1'],
      ['factory.run.ended', 'agent:session-1'],
    ]);
    expect(records[0]).toMatchObject({ actorType: 'human', metadata: { kickoffId: 'factory-kickoff:start-1:1' } });
    expect(await state.ledger()).toEqual([]);
  });
});
