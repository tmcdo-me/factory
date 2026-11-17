// fork(claude-agent): how the dispatcher reaches sessions that run on an agent runtime other than Mastra Code.
import type { InteractionRequest, RunEndReason } from '@factory/agent-runtime';
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
  /**
   * fork(claude-agent): for an adapter that owns the run's verdict (`ownsGoal`): whether the run's role had
   * handed the card on when the run ended (evaluated at its end event, so a later move keeps the verdict).
   */
  supersededAtEnd?: Promise<boolean>;
  /**
   * fork(claude-agent): for an adapter that owns the run's verdict: why the run failed, as the dispatcher
   * records it (`run_overdue`, `run_terminal_event_missing`, `run_configuration_invalid`, a run that
   * ended in error). Thrown by the dispatcher in place of one it would build from `reason` and `error`.
   */
  failure?: Error;
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
  /**
   * fork(claude-agent): what only an adapter that owns the run's goal (Mastra Code) is told. The thread
   * the run is on, which the session is moved to first.
   */
  thread?: { id: string; resourceId: string };
  /** Stop the run in flight before the kickoff (the rule says `cancelInFlight`). */
  cancelInFlight?: boolean;
  /** The exit tool the board approves itself when the run parks on it (Mastra Code names the tool; Claude Agent has `autoApprovePlan`). */
  autoApprovedTool?: string;
  /** The preface's identity in Mastra Code's inbox: its source and its dedupe key. */
  prefaceKeys?: { sourceId: string; dedupeKey: string };
  /** Whether the kickoff is still wanted (the card did not move on, the seat is still this run's): asked after the preface and before each redelivery. */
  stillWanted?: () => Promise<boolean>;
  /** Whether the run's role has handed the card on, asked as the run's end event arrives. */
  superseded?: () => Promise<boolean>;
  /** Said once the kickoff reached the session (a goal's reminder, for an adapter that owns the goal). */
  delivered?: () => Promise<void>;
}

/**
 * The dispatcher's view of sessions an adapter runs (Claude Agent), as opposed to the Mastra Code
 * sessions it drives through the agent controller. Every call names the session; `requestContext`
 * carries the session owner, whom the run acts as.
 */
export interface FactoryRuntimeSessions {
  /**
   * fork(claude-agent): the adapter keeps the run's goal itself (Mastra Code's objective loop re-kicks
   * inside one run and judges it): the dispatcher does not judge the run's goal, nor record the
   * run's end in the thread's ledger (the session's own listener does).
   */
  readonly ownsGoal?: boolean;
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
  /**
   * fork(claude-agent): whether the session's last turn ended waiting on a person, having asked them
   * something in plain text (not with `ask_user`) that the run's `goal` needs answered: the question,
   * or `undefined` (it asked nothing, it can go on by itself, or nobody could tell).
   */
  askedPerson?(sessionId: string, goal: { objective: string }): Promise<string | undefined>;
  /**
   * fork(claude-agent): park the session's board run on that question, as `ask_user` parks it: it
   * waits in the inbox and attention lists until the person answers there or replies in the session.
   * `resumed` is how their reply's turn ends; it ends as aborted when the wait is dropped (the run
   * stopped, another kickoff). `undefined` when nobody can be asked here.
   */
  awaitReply?(
    sessionId: string,
    wait: { question: string },
    requestContext: RequestContext,
  ): Promise<{ resumed: Promise<RuntimeRunEnd> } | undefined>;
  /** Resolves once the session has no run in flight (at once when it has none). Unbounded: callers time it. */
  idle(sessionId: string): Promise<void>;
  /** Start a board run. Resolves once the runtime has the turn; `ended` once the run ends. */
  kickoff(
    sessionId: string,
    kickoff: RuntimeKickoff,
    requestContext: RequestContext,
  ): Promise<{
    ended: Promise<RuntimeRunEnd>;
    /** The run's end as the adapter has seen it so far, for a run record that starts after the run may have ended. */
    observedEnd?: () => 'complete' | 'aborted' | 'error' | 'suspended' | undefined;
    /** Stop watching the run (it answers nothing more, its `ended` settles): called when the caller fails before it follows the run. */
    close?: () => void;
  }>;
  /**
   * Tell the session something from Factory (a rule's message, activity on the card's source).
   * `wake` starts a turn with it (queued behind a run in flight), named by the `runId` it resolves
   * with; otherwise it is kept (across restarts, where the server stores it) for the next turn, and
   * resolves with no run. Rejects when it could not be kept. `duplicate` when one with the same
   * `dedupeKey` already reached the session (nothing was kept or started).
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
      /**
       * fork(claude-agent): what the message is about, so it reaches the session once however often it
       * is sent (a GitHub event that came by webhook and by poll, or again after a restart). A second
       * message with the same key is dropped, for as long as the first is remembered.
       */
      dedupeKey?: string;
      /** How urgently Mastra Code's inbox treats it (default `high`); Claude Agent ignores it. */
      priority?: 'low' | 'medium' | 'high' | 'urgent';
      /** What the notification names as its source, for Mastra Code's inbox; Claude Agent ignores it. */
      sourceId?: string;
      /** The decision's idempotency key: Mastra Code's inbox drops a second message with it. Claude Agent ignores it. */
      idempotencyKey?: string;
      /**
       * The thread the message is for, when the session may be on another (Mastra Code sessions switch
       * threads; the session is moved to it first). Claude Agent sessions have one thread.
       */
      thread?: { id: string; resourceId: string };
    },
    requestContext: RequestContext,
  ): Promise<{ runId?: string; duplicate?: boolean }>;
  /** The notifications sessions here were sent (see `message`'s `delivery`). */
  deliveries?: Pick<
    AgentMessageStore,
    'durable' | 'get' | 'recentOnThread' | 'claimReply' | 'extendReply' | 'confirmReply' | 'releaseReply'
  >;
  abort(sessionId: string, requestContext: RequestContext): Promise<void>;
  /**
   * The calls a session waits on for a yes or no (a plan to approve, a gated tool), as a suspended
   * Mastra Code run's approvals are answered from the inbox, the card, or `factory_answer_approval`.
   */
  approvals?: RuntimeApprovals;
  /** The questions a session waits on (its `ask_user` calls), answered from outside it with an answer. */
  questions?: RuntimeQuestions;
}

/** A session's questions still waiting (`ask_user`, or a run's turn that ended asking in plain text), and how each is answered. */
export interface RuntimeQuestions {
  /**
   * Oldest first, each named by its interaction id and, when a tool call asked it, that call's id.
   */
  waiting(sessionId: string): Promise<WaitingQuestion[]>;
  /**
   * Answer one, named by its tool call or interaction id. The run carries on as `requestContext` (the
   * session's owner); `answeredBy` is who answered. `not_pending` when nothing waits on it any more.
   */
  answer(
    sessionId: string,
    target: { toolCallId?: string; interactionId?: string },
    answer: { answer: string | string[]; answeredBy?: string },
    requestContext: RequestContext,
  ): Promise<'answered' | 'not_pending'>;
}

/** A question a session waits on. */
export interface WaitingQuestion {
  toolCallId?: string;
  interactionId?: string;
  toolName: string;
  /** What it asks, so an answer can be checked against its options. */
  request?: InteractionRequest;
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
