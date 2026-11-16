// fork(claude-agent): how the dispatcher reaches sessions that run on an agent runtime other than Mastra Code.
import type { RunEndReason } from '@factory/agent-runtime';
import type { RequestContext } from '@mastra/core/request-context';

import type { AgentMessageDelivery, AgentMessageStore } from '../storage/domains/agent-messages/base.js';

/** How a run ended, as the runtime reports it. */
export interface RuntimeRunEnd {
  reason: RunEndReason;
  error?: string;
  /**
   * For a run parked on a person (`awaiting_interaction`): how it ends once they answer, its turn
   * going on. Never settles when the run is lost with its process.
   */
  resumed?: Promise<RuntimeRunEnd>;
  /** Token usage the runtime reported for the run, one entry per report. */
  usage?: readonly RuntimeRunUsage[];
}

/** One token usage report, as the runtime counts it (see the `usage` Factory event). */
export interface RuntimeRunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
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
  /** The goal the run pursues (the phase's `runner.goal`), told to the session with the kickoff. */
  goal?: { objective: string; maxRuns: number };
  /**
   * A goal's re-kick: the run goes on with this reminder (Factory's verdict and what remains), shown
   * as Factory's, in place of a skill or a prompt. The session keeps the Claude Code it has.
   */
  continuation?: string;
}

/**
 * The dispatcher's view of sessions an adapter runs (Claude Agent), as opposed to the Mastra Code
 * sessions it drives through the agent controller. Every call names the session; `requestContext`
 * carries the session owner, whom the run acts as.
 */
export interface FactoryRuntimeSessions {
  /** Whether this session runs on a runtime reached through here. Throws when that can't be read. */
  runs(sessionId: string): Promise<boolean>;
  /**
   * Whether a run with this id was started in the session and may still be going. A run lives only as
   * long as the process running it, so a kickoff from before a restart is owed again.
   */
  hasRun(sessionId: string, runId: string): Promise<boolean>;
  /** Whether a run is in flight in the session in this process. */
  isRunning(sessionId: string): boolean;
  /**
   * Whether the run in flight is a board run parked on a person (its own question or plan, still
   * pending). A person's own turn, parked or not, is never this.
   */
  parkedBoardRun(sessionId: string): Promise<boolean>;
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
   * `wake` starts a turn with it (queued behind a run in flight), named by the `runId` it resolves
   * with; otherwise it is kept (across restarts, where the server stores it) for the next turn, and
   * resolves with no run. Rejects when it could not be kept.
   */
  message(
    sessionId: string,
    message: {
      text: string;
      source: string;
      wake: boolean;
      /** What the message says about itself (its kind, who sent it), for Claude to read. */
      attributes?: Record<string, string | number | boolean>;
      /**
       * The session-to-session notification this message is, under the id Claude sees it by: the
       * session can answer it, and the sender's rate limit counts it.
       */
      delivery?: { id: string } & AgentMessageDelivery;
    },
    requestContext: RequestContext,
  ): Promise<{ runId?: string }>;
  /** The notifications sessions here were sent (see `message`'s `delivery`). */
  deliveries?: Pick<AgentMessageStore, 'get' | 'recentOnThread'>;
  abort(sessionId: string, requestContext: RequestContext): Promise<void>;
  /**
   * The calls a session waits on for a yes or no (a plan to approve, a gated tool), as a suspended
   * Mastra Code run's approvals are answered from the inbox, the card, or `factory_answer_approval`.
   */
  approvals?: RuntimeApprovals;
}

/** A session's calls that wait on a person's yes or no, and how each is answered. */
export interface RuntimeApprovals {
  /** Oldest first, each named by the tool call that asked. */
  waiting(sessionId: string): Promise<Array<{ toolCallId: string; toolName: string }>>;
  /**
   * Answer one. The run carries on as `requestContext` (the session's owner); `answeredBy` is who
   * decided. `not_pending` when nothing waits on that call any more.
   */
  answer(
    sessionId: string,
    toolCallId: string,
    answer: { decision: 'approve' | 'decline'; reason?: string; answeredBy?: string },
    requestContext: RequestContext,
  ): Promise<'answered' | 'not_pending'>;
}

/**
 * fork(claude-agent): thread-scoped state Factory keeps for runs on another runtime: the goal a phase's
 * runs pursue (as Mastra Code's objective is held) and the open-run ledger. Mastra's `threadState`
 * storage domain: one value per thread and type, replaced whole.
 */
export interface RuntimeThreadState {
  getState<T = unknown>(args: { threadId: string; type: string }): Promise<T | undefined>;
  setState<T = unknown>(args: { threadId: string; type: string; value: T }): Promise<void>;
}
