// fork(claude-agent)
import type { GoalObjectiveRecord } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';

import {
  holdRuntimeGoal,
  judgeRuntimeGoal,
  runtimeGoal,
  runtimeGoalStore,
  runtimeUsageSteps,
} from './runtime-run-lifecycle.js';
import type { RuntimeThreadState } from './runtime-sessions.js';

function memory(): RuntimeThreadState {
  const values = new Map<string, unknown>();
  return {
    getState: async <T>({ threadId, type }: { threadId: string; type: string }) =>
      structuredClone(values.get(`${threadId} ${type}`)) as T | undefined,
    setState: async ({ threadId, type, value }) => {
      values.set(`${threadId} ${type}`, structuredClone(value));
    },
  };
}

const goal = runtimeGoal('decision-1', 'thread-1', { objective: 'Ship it.', maxRuns: 3 });

describe('runtime phase goals', () => {
  it("defaults maxRuns as Mastra Code's goals do", () => {
    expect(runtimeGoal('d', 't', { objective: 'x' }).maxRuns).toBe(50);
  });

  it('keeps a goal held under the same id, resuming it when paused, and replaces any other', async () => {
    const store = memory();
    const goals = runtimeGoalStore(store);
    await goals.write('thread-1', {
      id: 'other',
      objective: 'Old.',
      status: 'active',
      runsUsed: 4,
      startedAt: 1,
      updatedAt: 1,
    });

    expect(await holdRuntimeGoal(store, goal)).toMatchObject({
      id: 'decision-1',
      status: 'active',
      runsUsed: 0,
      maxRuns: 3,
    });
    const held = (await goals.read('thread-1'))!;
    await goals.write('thread-1', { ...held, status: 'paused', runsUsed: 3, pausedReason: 'spent' });

    const resumed = await holdRuntimeGoal(store, goal);
    expect(resumed).toMatchObject({ status: 'active', runsUsed: 3, startedAt: held.startedAt });
    expect(resumed).not.toHaveProperty('pausedReason');
  });

  it('counts each judged turn, and re-kicks only while the goal is unmet and runs remain', async () => {
    const store = memory();
    await holdRuntimeGoal(store, goal);

    expect(await judgeRuntimeGoal(store, goal, async () => 'unmet')).toMatchObject({ attempt: 1 });
    expect(await judgeRuntimeGoal(store, goal, async () => 'unmet')).toMatchObject({ attempt: 2 });
    expect(await judgeRuntimeGoal(store, goal, async () => 'unmet')).toBeUndefined();
    expect(await runtimeGoalStore(store).read('thread-1')).toMatchObject({ status: 'paused', runsUsed: 3 });
  });

  it('marks a met goal done, and leaves the count alone when the run no longer holds the phase', async () => {
    const store = memory();
    await holdRuntimeGoal(store, goal);

    expect(await judgeRuntimeGoal(store, goal, async () => 'stale')).toBeUndefined();
    expect(await runtimeGoalStore(store).read('thread-1')).toMatchObject({ status: 'active', runsUsed: 0 });
    expect(await judgeRuntimeGoal(store, goal, async () => 'met')).toBeUndefined();
    expect(await runtimeGoalStore(store).read('thread-1')).toMatchObject({ status: 'done', runsUsed: 1 });
  });

  it('keeps an end that landed while Factory judged (the card left the phase), as Mastra Code discards its verdict', async () => {
    const store = memory();
    const goals = runtimeGoalStore(store);
    await holdRuntimeGoal(store, goal);

    const next = await judgeRuntimeGoal(store, goal, async () => {
      const record = (await goals.read('thread-1')) as GoalObjectiveRecord;
      await goals.write('thread-1', { ...record, status: 'done' });
      return 'unmet';
    });
    expect(next).toBeUndefined();
    expect(await goals.read('thread-1')).toMatchObject({ status: 'done', runsUsed: 0 });
  });

  it("reads a runtime's usage reports as a run record's steps", () => {
    expect(runtimeUsageSteps([{ inputTokens: 10, outputTokens: 5, cachedInputTokens: 90 }])).toEqual([
      { promptTokens: 100, completionTokens: 5, totalTokens: 105, cachedInputTokens: 90 },
    ]);
    expect(runtimeUsageSteps(undefined)).toEqual([]);
  });
});
