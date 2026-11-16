// fork(claude-agent): the run lifecycle Factory keeps for sessions on another agent runtime: phase goals
// (re-kicking a run until its goal is met or its runs are spent) and the open-run ledger.
import type { GoalObjectiveRecord } from '@mastra/core/storage';
import { DEFAULT_GOAL_MAX_RUNS, GOAL_STATE_TYPE } from '@mastra/core/tools';

import type { RunEndCaptureSession } from '../session/run-audit.js';
import type { RuntimeRunUsage, RuntimeThreadState } from './runtime-sessions.js';

/** A phase goal a run on another runtime pursues, held on its session's thread as Mastra Code's is. */
export interface RuntimeGoal {
  /** The decision's id, as Mastra Code keys a phase goal: a retried delivery keeps its goal and count. */
  id: string;
  threadId: string;
  objective: string;
  maxRuns: number;
}

/**
 * Factory's verdict on a run's goal, read after each turn that ended on its own: `met` once the card
 * left the phase (or the run handed it on to its own card), `stale` when the run no longer holds the
 * card's phase (handed on, superseded), `unmet` otherwise.
 */
export type RuntimeGoalVerdict = 'met' | 'unmet' | 'stale';

/** The goal's settings as a phase states them: `maxRuns` defaults as Mastra Code's does. */
export function runtimeGoal(id: string, threadId: string, goal: { objective: string; maxRuns?: number }): RuntimeGoal {
  return { id, threadId, objective: goal.objective, maxRuns: goal.maxRuns ?? DEFAULT_GOAL_MAX_RUNS };
}

/** Why a goal was parked with runs spent, as Mastra Code words it. */
export function goalBudgetPausedReason(maxRuns: number): string {
  return `Ran out of evaluation budget (${maxRuns} runs) before reaching the goal — raise maxRuns to resume.`;
}

/**
 * Hold `goal` on its thread. As Mastra Code's `startPhaseGoal` and goal reminder do: a goal already
 * held under this id is kept, with its count (a paused one goes back to active, so a retry runs at
 * least its kickoff and is then judged on what is left); anything else on the thread is replaced.
 */
export async function holdRuntimeGoal(store: RuntimeThreadState, goal: RuntimeGoal): Promise<GoalObjectiveRecord> {
  const existing = await store.getState<GoalObjectiveRecord>({ threadId: goal.threadId, type: GOAL_STATE_TYPE });
  const now = Date.now();
  if (existing?.id === goal.id) {
    if (existing.status !== 'paused') return existing;
    const { pausedReason: _pausedReason, ...resumed } = existing;
    const active: GoalObjectiveRecord = { ...resumed, status: 'active', updatedAt: now };
    await store.setState({ threadId: goal.threadId, type: GOAL_STATE_TYPE, value: active });
    return active;
  }
  const record: GoalObjectiveRecord = {
    id: goal.id,
    objective: goal.objective,
    status: 'active',
    runsUsed: 0,
    maxRuns: goal.maxRuns,
    startedAt: now,
    updatedAt: now,
  };
  await store.setState({ threadId: goal.threadId, type: GOAL_STATE_TYPE, value: record });
  return record;
}

/**
 * Judge a run's goal after a turn that ended on its own, as Mastra Code's goal step judges a settled
 * turn: the same record, count, budget and statuses, with Factory's own check (`verdict`) in place of
 * the model judge. Returns the re-kick to send (and its attempt) when the goal goes on, else `undefined` (met, parked
 * with its runs spent, or no longer this run's to pursue: ended, replaced, or the run handed on).
 */
export async function judgeRuntimeGoal(
  store: RuntimeThreadState,
  goal: RuntimeGoal,
  verdict: () => Promise<RuntimeGoalVerdict>,
): Promise<{ continuation: string; attempt: number } | undefined> {
  const read = () => store.getState<GoalObjectiveRecord>({ threadId: goal.threadId, type: GOAL_STATE_TYPE });
  const record = await read();
  if (record?.id !== goal.id || record.status !== 'active') return undefined;
  const maxRuns = record.maxRuns ?? goal.maxRuns;
  const write = (value: GoalObjectiveRecord) =>
    store.setState({ threadId: goal.threadId, type: GOAL_STATE_TYPE, value });
  // Re-entered with nothing left to judge with (a retry of a goal whose runs are spent): park it.
  if (record.runsUsed >= maxRuns) {
    await write({ ...record, status: 'paused', pausedReason: goalBudgetPausedReason(maxRuns), updatedAt: Date.now() });
    return undefined;
  }
  const judged = await verdict();
  if (judged === 'stale') return undefined;
  // Ended or replaced while Factory looked (the card left the phase): that verdict stands.
  const current = await read();
  if (current?.id !== goal.id || current.status !== 'active' || current.startedAt !== record.startedAt) {
    return undefined;
  }
  const runsUsed = current.runsUsed + 1;
  const spent = runsUsed >= maxRuns;
  const status: GoalObjectiveRecord['status'] = judged === 'met' ? 'done' : spent ? 'paused' : 'active';
  const { pausedReason: _pausedReason, ...rest } = current;
  await write({
    ...rest,
    runsUsed,
    status,
    ...(status === 'paused' ? { pausedReason: goalBudgetPausedReason(maxRuns) } : {}),
    updatedAt: Date.now(),
  });
  if (status !== 'active') return undefined;
  return {
    attempt: runsUsed,
    continuation:
      `[Goal attempt ${runsUsed}/${maxRuns}] The goal is not yet complete: the card is still in its phase. ` +
      'If you need an answer from a person that the repository cannot give you, ask it with ask_user.\n\n' +
      `Continue working toward the goal: ${goal.objective}`,
  };
}

/** The ledger entries Factory keeps for a thread, under the type Mastra Code's thread setting is named. */
const MAX_LEDGERS = 1000;

/**
 * The open-run ledger of each thread, kept in thread state rather than the thread's metadata (which the
 * agent controller writes with its own queue): the same entries, records and readers as Mastra Code's.
 * One handle per thread, so its writes queue in order (`run-audit` serializes by handle).
 */
export function runtimeRunLedgers(store: () => Promise<RuntimeThreadState | undefined>) {
  const handles = new Map<string, RunEndCaptureSession>();
  return (threadId: string): RunEndCaptureSession => {
    let handle = handles.get(threadId);
    if (handle) {
      handles.delete(threadId);
    } else {
      handle = {
        thread: {
          getSetting: async ({ key }) => (await store())?.getState({ threadId, type: key }),
          setSetting: async ({ key, value }) => {
            await (await store())?.setState({ threadId, type: key, value });
          },
        },
        // No agent-controller events: the dispatcher records each end itself.
        subscribe: () => () => {},
      };
    }
    handles.set(threadId, handle);
    for (const oldest of handles.keys()) {
      if (handles.size <= MAX_LEDGERS) break;
      handles.delete(oldest);
    }
    return handle;
  };
}

/** A runtime's usage reports as the steps of a run's audit record. */
export function runtimeUsageSteps(usage: readonly RuntimeRunUsage[] | undefined) {
  return (usage ?? []).map(({ inputTokens, outputTokens, cachedInputTokens, reasoningTokens }) => {
    const promptTokens = inputTokens + (cachedInputTokens ?? 0);
    return {
      promptTokens,
      completionTokens: outputTokens,
      totalTokens: promptTokens + outputTokens,
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
  });
}

/** The goal store `endPhaseGoal` reads and writes, over thread state. */
export function runtimeGoalStore(store: RuntimeThreadState) {
  return {
    read: (threadId: string) => store.getState<GoalObjectiveRecord>({ threadId, type: GOAL_STATE_TYPE }),
    write: (threadId: string, value: GoalObjectiveRecord) => store.setState({ threadId, type: GOAL_STATE_TYPE, value }),
  };
}
