// fork(claude-agent): how the dispatcher reaches sessions that run on an agent runtime other than Mastra Code.
import type { RunEndReason } from '@factory/agent-runtime';
import type { RequestContext } from '@mastra/core/request-context';

/** How a run ended, as the runtime reports it. */
export interface RuntimeRunEnd {
  reason: RunEndReason;
  error?: string;
}

/** A board run's first turn: a phase's skill, or a plain prompt. */
export interface RuntimeKickoff {
  /** The run's id: the decision's delivery id, so a re-claim recognises a kickoff that already landed. */
  runId: string;
  skill?: { name: string; arguments?: string; resume?: boolean };
  prompt?: string;
  /** The card's description, appended to the kickoff as data. */
  description?: string | null;
  /** Said to the session ahead of the kickoff (a rule's stage-transition message). */
  preface?: string;
  /**
   * Asked whenever this run (and only this run) submits a plan for approval: `true` approves it on
   * the board's behalf, `false` leaves it for a person. Without it every plan waits for a person.
   */
  autoApprovePlan?: () => boolean;
}

/**
 * The dispatcher's view of sessions an adapter runs (Claude Agent), as opposed to the Mastra Code
 * sessions it drives through the agent controller. Every call names the session; `requestContext`
 * carries the session owner, whom the run acts as.
 */
export interface FactoryRuntimeSessions {
  /** Whether this session runs on a runtime reached through here. */
  runs(sessionId: string): Promise<boolean>;
  /**
   * Whether a run with this id was started in the session and may still be going. A run lives only as
   * long as the process running it, so a kickoff from before a restart is owed again.
   */
  hasRun(sessionId: string, runId: string): Promise<boolean>;
  /** Whether a run is in flight in the session in this process. */
  isRunning(sessionId: string): boolean;
  /** Whether the session waits on a person (a question, a plan to approve). */
  awaitsPerson(sessionId: string): Promise<boolean>;
  /** Resolves once the session has no run in flight (at once when it has none). Unbounded: callers time it. */
  idle(sessionId: string): Promise<void>;
  /** Start a board run. Resolves once the runtime has the turn; `ended` once the run ends. */
  kickoff(
    sessionId: string,
    kickoff: RuntimeKickoff,
    requestContext: RequestContext,
  ): Promise<{ ended: Promise<RuntimeRunEnd> }>;
  /**
   * Tell the session something from Factory (a rule's message, activity on the card's source).
   * `wake` starts a turn with it (queued behind a run in flight); otherwise it waits for the next turn.
   */
  message(
    sessionId: string,
    message: { text: string; source: string; wake: boolean },
    requestContext: RequestContext,
  ): Promise<void>;
  abort(sessionId: string, requestContext: RequestContext): Promise<void>;
}
