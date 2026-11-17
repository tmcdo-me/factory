import { InteractionAnswerRefusedError } from '@factory/agent-runtime'; // fork(claude-agent)
import type { InteractionBroker, InteractionRecord, InteractionResponse } from '@factory/agent-runtime'; // fork(claude-agent)
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController, AgentControllerEventListener, Session } from '@mastra/core/agent-controller';
import { classifyProviderError, PROVIDER_CALL_ERROR_NAME } from '@mastra/core/error';
import { RequestContext } from '@mastra/core/request-context';
import type { GoalObjectiveRecord } from '@mastra/core/storage';

import { eventMovesCard, isPullRequestEvent } from '../boards/board-events.js';
import type { BoardEventFacts } from '../boards/board-events.js';
import {
  boardFlow,
  boardForWorkItem,
  cardBoardFlow,
  cardRuleFacts,
  hasPullRequest,
  intakeTarget,
  isPullRequestCard,
  isTerminalWorkItem,
  resolvePhaseSemantics,
  REVIEW_CONTEXT,
  reviewsPullRequest,
  workItemPhaseSemantics,
} from '../boards/index.js';
import type { BoardRegistry } from '../boards/index.js';
import {
  closedIssueRuleFacts,
  INTAKE_ROUTE_METADATA_KEY,
  landingPhase,
  placedByIntakeRoute,
  resolveEventRoute,
  resolveIntakePlacement,
  resolveIntakeRoute,
  routesHandleEvent,
} from '../boards/intake-routing.js';
import type { IntakeRoutesReader } from '../boards/intake-routing.js';
import { autoApprovedExitTool, startsInAutoPhase } from '../boards/phase-automation.js';
import { toBoardSource } from '../boards/project-boards.js';
import type { ProjectBoardSource } from '../boards/project-boards.js';
import { moveCardToBoard } from '../boards/relocate.js';
import {
  FACTORY_OPEN_RUN_STALE_MS,
  heartbeatSessionOpenRun,
  isOpenRunLiveElsewhere,
  listSessionOpenRuns,
  recordSessionRunEnd,
  recordSessionRunStart,
  waitForSessionRunAudit,
} from '../session/run-audit.js';
import type { FactoryRunUsageCounts } from '../session/run-audit.js';
import { resolvePromptInvocation, resolveSkillInvocation, resolveSkillResumeInvocation } from '../skills/service.js';
import type { SkillSession } from '../skills/service.js';
import { isHumanActorId } from '../storage/domains/audit/actors.js';
import type { AuditRecorder } from '../storage/domains/audit/domain.js';
import {
  externalSourceKey,
  FACTORY_RULE_MATERIALIZATION_KEY,
  FactoryRunBindingSupersededError,
  WorkItemSourceConflictError,
  WorkItemUpdateConflictError,
} from '../storage/domains/work-items/base.js';
import type {
  FactoryDeferredDecisionRecord,
  FactoryDispatchFailureCode,
  FactoryPendingStartRecord,
  FactoryRunBindingRecord,
  Card,
  WorkItemsStorage,
  UpsertWorkItemResult,
} from '../storage/domains/work-items/base.js';
import type { FactoryRunEndReporter } from '../tools/reports.js';
import { withWorkItemDescription } from '../work-items/description-context.js';
import { workItemProviderAdapter } from '../work-items/providers/index.js';
import { decisionOvertaken } from './decision-applicability.js';
import {
  FactoryDispatchError,
  factoryDispatchFailureCode,
  factoryDispatchFailureMetadata,
  MAX_ERROR_LENGTH,
  sanitizeDispatchError,
} from './dispatch-errors.js';
import { isStatusEventDecision } from './event-rules.js';
import { awaitNotification, factoryRequestContext, MastraCodeRuntimeSessions } from './mastra-code-sessions.js'; // fork(claude-agent)
import { endPhaseGoal, PHASE_GOAL_METADATA_KEY, phaseGoalOf, startPhaseGoal } from './phase-goal.js';
import {
  holdRuntimeGoal,
  judgeRuntimeGoal,
  runtimeGoal,
  runtimeGoalStore,
  runtimeRunLedgers,
  runtimeUsageSteps,
} from './runtime-run-lifecycle.js';
import type { RuntimeGoal, RuntimeGoalVerdict, RuntimeRunLedger } from './runtime-run-lifecycle.js';
import type { FactoryRuntimeSessions, RuntimeRunEnd, RuntimeThreadState } from './runtime-sessions.js';
import type { FactoryTransitionService } from './transition-service.js';
import type { FactoryCommitDecision, FactoryRuleActor, FactoryRuleCausalEntry } from './types.js';
import { authorTrusted, externalSourceForWorkItem, workItemSource } from './types.js';
import {
  assertFactoryDecisionTarget,
  MAX_FACTORY_RULE_CAUSAL_DEPTH,
  validateFactoryRuleDecision,
} from './validation.js';
import {
  FactoryDecisionSuperseded,
  MAX_PLAN_APPROVALS,
  RUN_REGISTRY_HEARTBEAT_MS,
  RunEndedInError,
  runErrorFailure,
  watchRun,
} from './watch-run.js'; // fork(claude-agent)
import type { ApprovePausedCall } from './watch-run.js';

const LEASE_MS = 30_000;
/** How long the run waits on a status-comment write; well inside one lease so a slow provider never costs the claim. */
const REVIEW_STATUS_TIMEOUT_MS = 10_000;
// Cadence while dispatches are in flight or a cycle filled its batch. An idle
// dispatcher does not poll: it sleeps until the next row becomes claimable or
// a write wakes it.
const POLL_MS = 1_000;
// Safety net for an idle dispatcher: a wake lost in transit (a pubsub outage, a
// write from a process that does not publish) is picked up within this window.
// Well above Neon's 5-minute autosuspend so an idle database still sleeps.
const IDLE_RECHECK_MS = 60 * 60_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

// fork(claude-agent): how long a run waits for the broker to record the call it paused on (it takes
// a moment after the controller reports it) before leaving it for a person.
const HELD_RECORD_WAIT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
// A run the registry still shows past this is a hang, not a slow run: failed
// terminally so the lease and the in-flight slot come back.
const SKILL_COMPLETION_OBSERVATION_TIMEOUT_MS = 6 * 60 * 60_000;
// Dispatches can legitimately run for minutes. Woken skill invocations hold
// capacity until their agent run reaches a terminal state; binding preparation
// also runs detached from the poll loop under this concurrency cap.
const MAX_IN_FLIGHT = 10;
/**
 * Decisions that may start or wake an agent run, or wait for one to end, and so
 * hold a run slot. A transition's message is queued as a separate sendMessage,
 * so a transition stays bookkeeping, and so does a status event's route move:
 * it never waits for a run inline, it hands itself back until the run ends.
 */
export const isRunBearingDecision = (decision: Record<string, unknown>): boolean =>
  decision.type === 'invokeSkill' || decision.type === 'sendMessage' || decision.type === 'signalActivity';
const isBookkeepingDecision = (decision: Record<string, unknown>): boolean => !isRunBearingDecision(decision);
const BOOKKEEPING_MAX_IN_FLIGHT = 4;
// Staleness sweep: legacy/leaked active bindings (item deleted, transition
// path bypassed, or pre-dating terminal-stage revocation) are revoked on a
// slow cadence so the per-tick reconcile walk stays bounded.
const STALE_BINDING_SWEEP_INTERVAL_MS = 10 * 60_000;
const STALE_BINDING_TTL_MS = 24 * 60 * 60_000;
// The bound-thread reconcile walk reads a cursor + messages per binding; it
// exists to catch results missed at run end, so it runs on a slow cadence off
// the claim path rather than on every 1s tick.
const RECONCILE_INTERVAL_MS = 30_000;

/** The decision cannot act yet and did nothing: it goes back to the queue and is claimed again later. */
class FactoryDecisionPostponed extends Error {}

// How often a decision that cannot act yet (a route move waiting on the card's run) is tried again.
const POSTPONE_MS = 10_000;

/** A run in the review seat: a pull request review, unless it is the card's board's self-review. */
function reviewSeatSkill(decision: unknown): { skillName?: unknown } | undefined {
  if (!decision || typeof decision !== 'object') return undefined;
  const value = decision as { type?: unknown; role?: unknown; skillName?: unknown };
  return value.type === 'invokeSkill' && value.role === REVIEW_CONTEXT ? value : undefined;
}

// Rescheduling a failure that can never succeed only delays the moment a person sees why.
function isTerminalFailure(attempts: number, failureCode: FactoryDispatchFailureCode): boolean {
  const failure = factoryDispatchFailureMetadata(failureCode);
  return (
    attempts >= (failureCode === 'run_incomplete' ? 2 : MAX_ATTEMPTS) ||
    !failure.canRetry ||
    failure.autoRetry === false
  );
}

/** fork(claude-agent): the interaction broker's records of what Mastra Code sessions wait on, and how they're answered. */
export interface DispatcherInteractions {
  broker: Pick<InteractionBroker, 'resolve'>;
  /** The pending record a session holds for a call, once it is kept; `undefined` after `timeoutMs`. */
  whenWaitingOn(sessionId: string, callId: string, timeoutMs: number): Promise<InteractionRecord | undefined>;
  /**
   * Tell the session's followers it waits on a call the board meant to answer and didn't (it gave up,
   * or the session refused its answer): its notice was held back for the board. `record` is the
   * broker's, when it kept one.
   */
  announce?(call: { sessionId: string; toolCallId: string; toolName: string; record?: InteractionRecord }): void;
}

/** fork(claude-agent): the yes that answers a paused call, when a bare yes answers it. */
function approvalOf(request: InteractionRecord['request']): InteractionResponse | undefined {
  if (request.kind === 'plan_approval') return { kind: 'plan_approval', action: 'approved' };
  // A tool that paused itself for a yes or no; a gate holds its run open and never parks it here.
  if (request.kind === 'tool_approval' && !request.gate) return { kind: 'tool_approval', approved: true };
  return undefined;
}

interface SessionOwner {
  userId: string;
  orgId: string;
}

interface DispatcherSession extends SkillSession {
  thread: {
    switch(input: { threadId: string }): Promise<unknown>;
    listActiveMessages(): Promise<Array<{ id: string }>>;
  };
  stream: { isActive(): boolean };
  abort(): void;
  sendSignal(
    input: {
      id: string;
      type: 'user' | 'reactive';
      tagName: string;
      attributes?: { name: string };
      contents: string;
    },
    options: { requestContext: RequestContext; requireDelivery?: boolean },
  ): { accepted: Promise<{ accepted: true; runId?: string; action?: string }> };
  subscribe(listener: AgentControllerEventListener): () => void;
}

type FactoryController = Pick<AgentController<MastraCodeState>, 'getSession' | 'listActiveThreadRuns'>;
type BoundDispatcherSession = Session<MastraCodeState>;

// fork(claude-agent): a board run on another runtime, as the dispatcher drives it through the seam.
interface SeamWorkingPhase {
  /** After the run's clean end: throws `run_incomplete` when it left the card where it was. */
  verify(): Promise<void>;
  /** Factory's judgement of the phase's goal after one of the run's turns. */
  verdict(): Promise<RuntimeGoalVerdict>;
}

/** The pull requests a card carries, by source key: its own source, or any attached to it. */
function pullRequestSourcesOf(card: Card): string[] {
  const ownKey = card.externalSource?.type === 'pull-request' ? externalSourceKey(card.externalSource) : null;
  const own = ownKey ? [ownKey] : [];
  const attached = (card.workItem?.sources ?? [])
    .filter(source => source.sourceType === 'pull-request')
    .map(source => source.sourceKey ?? source.id);
  return [...own, ...attached];
}

/** Start a turn of a seam run (its kickoff or a goal's re-kick). */
type SeamSend = (
  kickoff: Omit<Parameters<FactoryRuntimeSessions['kickoff']>[1], 'autoApprovePlan'>,
) => Promise<{ ended: Promise<RuntimeRunEnd> }>;

type SeamGoalStep =
  | { kind: 'done' }
  | { kind: 'busy' }
  | { kind: 'rekicked'; started: { ended: Promise<RuntimeRunEnd> } }
  // fork(claude-agent): parked on a question the turn asked in plain text; `resumed` once the person replied.
  | { kind: 'waiting'; resumed: Promise<RuntimeRunEnd> };

interface SeamRun {
  /** The adapter that runs the kickoff (Claude Agent's, or Mastra Code's, which keeps its own goal loop). */
  seam: Pick<FactoryRuntimeSessions, 'kickoff' | 'ownsGoal'>;
  /** Mastra Code: the controller session the run lives in; its run record is the session's own. */
  session?: BoundDispatcherSession;
  binding: FactoryRunBindingRecord;
  startedBy: string;
  orgId: string;
  attempts: number;
  label: string;
  kickoff: Omit<Parameters<FactoryRuntimeSessions['kickoff']>[1], 'autoApprovePlan'>;
  /** The exit tool the board approves itself for this card; only `submit_plan` asks a person. */
  autoApprovedTool?: string;
  superseded?: () => Promise<boolean>;
  workingPhase?: SeamWorkingPhase;
  /** The phase goal the run pursues (only a run working its card's phase). */
  goal?: RuntimeGoal;
  /** Who approved the run, for its run record; a human approver is its actor. */
  approvedBy?: string;
  workItemName?: string;
  onStarted?: () => Promise<void>;
  onSuperseded?: () => Promise<void>;
}

export interface FactoryBindingPreparationInput {
  record: FactoryDeferredDecisionRecord;
  item: Card;
  role: string;
  expectedBindingId?: string;
}

export type FactoryReviewStatusPhase = 'queued' | 'reviewing' | 'retrying' | 'completed' | 'failed' | 'cancelled';

/** One step of a review run, identified by the decision that started it. */
export interface FactoryReviewStatusEvent {
  orgId: string;
  factoryProjectId: string;
  workItemId: string;
  run: string;
  requestedAt: Date;
  generation: number;
  attempt: number;
  phase: FactoryReviewStatusPhase;
  /** When the agent was handed the review; set on the 'reviewing' step. */
  startedAt?: Date;
  /** When the run ended; set on final steps. */
  endedAt?: Date;
  /** Why the run failed or will retry, already sanitized. */
  reason?: string;
  /** A final step for a run an earlier attempt started: the comment's recorded start still applies. */
  replayed?: true;
}

export type FactoryReviewStatusReporter = (event: FactoryReviewStatusEvent) => Promise<void>;

export interface FactoryDecisionDispatcherOptions {
  audit?: AuditRecorder;
  controller: FactoryController;
  transitionService: Pick<FactoryTransitionService, 'transition' | 'configVersion'>;
  storage: WorkItemsStorage;
  /** Installed boards; defaults to the built-in Work and Review boards. */
  boards?: BoardRegistry | ProjectBoardSource;
  /** The project's intake routes, which place newly filed linked cards. Without it, decisions place cards as they say. */
  intakeRoutes?: IntakeRoutesReader;
  ownerId?: string;
  reconcileToolResults?: () => Promise<void>;
  reconcileRunBinding?: (binding: FactoryRunBindingRecord) => Promise<void>;
  prepareBinding?: (input: FactoryBindingPreparationInput) => Promise<void>;
  primeCredentials?: (tenant: { orgId: string; userId: string }) => Promise<void>;
  /**
   * Told when a run fails terminally at dispatch, so whoever follows the item
   * hears about failures no run end covers. How runs end is reported by the
   * per-session listener (`observeSessionRunReports`). Never throws.
   */
  reportRunEnd?: FactoryRunEndReporter;
  /**
   * Told each step of a pull request review run: accepted, started, retrying,
   * and how it ended. Driven by the dispatcher rather than the agent, so a run
   * that crashes or is cancelled still reports its end. Must not throw.
   */
  reportReviewStatus?: FactoryReviewStatusReporter;
  /** Dismisses superseded Factory change requests on a GitHub pull request. */
  dismissStaleReviews?: (decision: Extract<FactoryCommitDecision, { type: 'dismissStaleReviews' }>) => Promise<void>;
  resolveLinkedWorkItemParentId?: (input: {
    orgId: string;
    factoryProjectId: string;
    decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>;
  }) => Promise<string | null>;
  /** `false` spends a linked-card decision unfiled: its Factory project was deleted after the decision committed. */
  factoryProjectExists?: (tenant: { orgId: string; factoryProjectId: string }) => Promise<boolean>;
  /** fork(claude-agent): sessions that run on another agent runtime (Claude Agent), reached through the seam. */
  runtimeSessions?: FactoryRuntimeSessions;
  /**
   * fork(claude-agent): slice 5d. What Mastra Code sessions wait on, in the interaction broker: a run
   * approves its phase's own exit tool through it. Without it every pause waits for a person.
   */
  interactions?: DispatcherInteractions;
  /**
   * fork(claude-agent): where those sessions' phase goals and open-run ledgers are kept (Mastra's
   * `threadState`). Without it their runs pursue no goal and leave no run records.
   */
  runtimeThreadState?: () => Promise<RuntimeThreadState | undefined>;
  /**
   * fork(claude-agent): told after each turn of a card's run that ended on its own, on either runtime,
   * before Factory judges it: files the pull request the run opened on its own branch, when no tool
   * result named it (see `FactoryPhaseStateProcessor.attachOwnBranchPullRequest`). Never throws.
   */
  afterRunTurn?: (binding: FactoryRunBindingRecord) => Promise<void>;
  maxInFlight?: number;
  /** How often the stale-binding sweep runs. Defaults to 10 minutes. */
  staleBindingSweepIntervalMs?: number;
  /** Active bindings older than this are revoked by the sweep. Defaults to 24 hours. */
  staleBindingTtlMs?: number;
  /** How often the bound-thread reconcile walk runs. Defaults to 30 seconds. */
  reconcileIntervalMs?: number;
  /**
   * How long a run the registry still shows in flight is observed before it fails as overdue. Defaults to 6 hours.
   * A run the registry no longer shows fails for retry at the next ten-minute heartbeat instead.
   */
  skillCompletionObservationTimeoutMs?: number;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function retryAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(1_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS));
}

function externalSourceForDecision(decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>) {
  return externalSourceForWorkItem(decision.source, decision.sourceKey, decision.url ?? undefined);
}

function deferredActor(record: FactoryDeferredDecisionRecord): FactoryRuleActor {
  const actor = record.actor;
  if (
    actor?.type === 'github' &&
    typeof actor.login === 'string' &&
    typeof actor.trusted === 'boolean' &&
    typeof actor.factoryAuthored === 'boolean'
  ) {
    return {
      type: 'github',
      login: actor.login,
      trusted: actor.trusted,
      factoryAuthored: actor.factoryAuthored,
    };
  }
  return { type: 'system', id: 'factory-rule-dispatcher' };
}

function externalActor(actor: FactoryDeferredDecisionRecord['actor']): boolean {
  return actor !== null && actor.type !== 'human' && actor.type !== 'agent' && actor.type !== 'system';
}

/** A run start asks for consent; an external event asks before pulling a card back into a working lane. */
function requestsConsent(
  boards: BoardRegistry,
  record: FactoryDeferredDecisionRecord,
  decision: FactoryCommitDecision,
): boolean {
  if (decision.type === 'invokeSkill') return true;
  if (decision.type !== 'transition' || !externalActor(record.actor)) return false;
  // Fail closed: a phase the installed board does not declare is treated as working, so consent is asked.
  return (resolvePhaseSemantics(boards, decision.board, decision.stage)?.kind ?? 'working') === 'working';
}

// The Factory reviewing code it wrote is part of the same work, not new work to
// consent to: a push to a Factory-authored PR re-reviews without a person's click.
function reviewsFactoryAuthoredCode(
  boards: BoardRegistry,
  item: Pick<Card, 'metadata' | 'externalSource' | 'workItem'>,
  decision: FactoryCommitDecision,
): boolean {
  if (item.metadata?.factoryAuthored !== true) return false;
  if (decision.type === 'transition') {
    const flow = boardFlow(boards.get(decision.board));
    return (
      decision.stage === flow.pullRequestReview &&
      reviewsPullRequest({
        flow,
        item: { source: workItemSource(item.externalSource), workItem: item.workItem },
      })
    );
  }
  return decision.type === 'invokeSkill' && decision.role === REVIEW_CONTEXT;
}

function leaseIdentity(
  record: Pick<FactoryDeferredDecisionRecord | FactoryPendingStartRecord, 'id' | 'orgId' | 'factoryProjectId'>,
  ownerId: string,
) {
  return { id: record.id, orgId: record.orgId, factoryProjectId: record.factoryProjectId, ownerId };
}

export class FactoryDecisionDispatcher {
  readonly #audit?: AuditRecorder;
  readonly #controller: FactoryController;
  readonly #mastraCode: MastraCodeRuntimeSessions; // fork(claude-agent)
  readonly #transitionService: Pick<FactoryTransitionService, 'transition' | 'configVersion'>;
  readonly #boards: ProjectBoardSource;
  readonly #intakeRoutes?: IntakeRoutesReader;
  readonly #storage: WorkItemsStorage;
  readonly #ownerId: string;
  readonly #autoApproving = new Set<string>();
  readonly #interactions?: DispatcherInteractions; // fork(claude-agent)
  readonly #reconcileToolResults?: () => Promise<void>;
  readonly #reconcileRunBinding?: FactoryDecisionDispatcherOptions['reconcileRunBinding'];
  readonly #afterRunTurn?: FactoryDecisionDispatcherOptions['afterRunTurn']; // fork(claude-agent)
  readonly #prepareBinding?: (input: FactoryBindingPreparationInput) => Promise<void>;
  readonly #primeCredentials?: (tenant: { orgId: string; userId: string }) => Promise<void>;
  readonly #reportRunEnd?: FactoryRunEndReporter;
  readonly #dismissStaleReviews?: FactoryDecisionDispatcherOptions['dismissStaleReviews'];
  readonly #reportReviewStatus?: FactoryReviewStatusReporter;
  /** Review attempts that already said `queued`, and those that watched their run start. */
  readonly #reviewQueued = new WeakSet<FactoryDeferredDecisionRecord>();
  readonly #reviewWatched = new WeakSet<FactoryDeferredDecisionRecord>();
  /** Re-claims that found an earlier attempt's kickoff landed and its run already over. */
  readonly #reviewReplayed = new WeakSet<FactoryDeferredDecisionRecord>();
  /** Last pending status-comment write per run, so writes stay ordered. */
  /**
   * Per review run: the write chain, the newest step issued, and how many
   * writes were issued and how far the landed ones reach, so a write that
   * outlived its wait and landed after a newer one can be repaired.
   */
  readonly #reviewStatusRuns = new Map<
    string,
    { tail: Promise<void>; issued: number; landed: number; latest: FactoryReviewStatusEvent }
  >();
  readonly #resolveLinkedWorkItemParentId?: FactoryDecisionDispatcherOptions['resolveLinkedWorkItemParentId'];
  readonly #factoryProjectExists?: FactoryDecisionDispatcherOptions['factoryProjectExists'];
  readonly #runtimeSessions?: FactoryRuntimeSessions; // fork(claude-agent)
  // fork(claude-agent): seam sessions' goals and ledgers, and the seam runs this process follows.
  readonly #runtimeThreadState?: () => Promise<RuntimeThreadState | undefined>;
  readonly #seamLedger?: (threadId: string) => RuntimeRunLedger;
  /** Seam runs this process follows, by kickoff id, with the timer renewing their ledger entry. */
  readonly #seamOpenRuns = new Map<string, ReturnType<typeof setInterval> | undefined>();
  readonly #maxInFlight: number;
  readonly #staleBindingSweepIntervalMs: number;
  readonly #staleBindingTtlMs: number;
  #lastStaleBindingSweepAt?: Date;
  readonly #reconcileIntervalMs: number;
  readonly #skillCompletionObservationTimeoutMs: number;
  #lastReconcileAt?: Date;
  #reconcileInFlight?: Promise<void>;
  /** A reconcile is due once activity stops, to drain results of runs that just ended. */
  #reconcileOwed = true;
  /** Last step seen on a bound session thread; counts as activity for one reconcile interval. */
  #lastBoundThreadRunAt?: number;
  #started = false;
  #stopping = false;
  #wakeRequested = false;
  #unsubscribeClaimableWork?: () => void;
  #loop?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;
  /** Starts and run-bearing decisions; capped by `maxInFlight`. */
  readonly #runInFlight = new Set<Promise<void>>();
  /** Fast board bookkeeping (transitions, linked-card upserts); its own small cap. */
  readonly #bookkeepingInFlight = new Set<Promise<void>>();
  /** Background work awaited on stop but outside both caps. */
  readonly #backgroundInFlight = new Set<Promise<void>>();
  readonly #bindingSkillRuns = new Map<string, Promise<void>>();

  constructor(options: FactoryDecisionDispatcherOptions) {
    this.#audit = options.audit;
    this.#controller = options.controller;
    this.#transitionService = options.transitionService;
    this.#boards = toBoardSource(options.boards);
    this.#intakeRoutes = options.intakeRoutes;
    this.#storage = options.storage;
    this.#ownerId = options.ownerId ?? `factory-dispatcher:${globalThis.crypto.randomUUID()}`;
    this.#reconcileToolResults = options.reconcileToolResults;
    this.#reconcileRunBinding = options.reconcileRunBinding;
    this.#afterRunTurn = options.afterRunTurn; // fork(claude-agent)
    this.#prepareBinding = options.prepareBinding;
    this.#primeCredentials = options.primeCredentials;
    this.#reportRunEnd = options.reportRunEnd;
    this.#dismissStaleReviews = options.dismissStaleReviews;
    this.#reportReviewStatus = options.reportReviewStatus;
    this.#resolveLinkedWorkItemParentId = options.resolveLinkedWorkItemParentId;
    this.#factoryProjectExists = options.factoryProjectExists;
    this.#runtimeSessions = options.runtimeSessions; // fork(claude-agent)
    this.#interactions = options.interactions; // fork(claude-agent)
    // fork(claude-agent)
    this.#runtimeThreadState = options.runtimeThreadState;
    if (options.runtimeThreadState) this.#seamLedger = runtimeRunLedgers(options.runtimeThreadState);
    const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
    this.#maxInFlight = Number.isFinite(maxInFlight) && maxInFlight > 0 ? Math.floor(maxInFlight) : MAX_IN_FLIGHT;
    this.#staleBindingSweepIntervalMs = positiveMs(
      options.staleBindingSweepIntervalMs,
      STALE_BINDING_SWEEP_INTERVAL_MS,
    );
    this.#staleBindingTtlMs = positiveMs(options.staleBindingTtlMs, STALE_BINDING_TTL_MS);
    this.#reconcileIntervalMs = positiveMs(options.reconcileIntervalMs, RECONCILE_INTERVAL_MS);
    this.#skillCompletionObservationTimeoutMs = positiveMs(
      options.skillCompletionObservationTimeoutMs,
      SKILL_COMPLETION_OBSERVATION_TIMEOUT_MS,
    );
    // fork(claude-agent)
    this.#mastraCode = new MastraCodeRuntimeSessions(options.controller, {
      timeoutMs: this.#skillCompletionObservationTimeoutMs,
      autoApproving: this.#autoApproving,
      approver: (sessionId, requestContext, label) => this.#approver(sessionId, requestContext, label),
    });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#unsubscribeClaimableWork = this.#storage.onClaimableWork(() => this.wake());
    this.wake();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#unsubscribeClaimableWork?.();
    this.#unsubscribeClaimableWork = undefined;
    this.#clearTimer();
    await this.#loop;
    await Promise.allSettled([...this.#runInFlight, ...this.#bookkeepingInFlight, ...this.#backgroundInFlight]);
    this.#started = false;
    this.#stopping = false;
  }

  /**
   * Runs a dispatch cycle now. Called after any write that leaves claimable
   * work, locally or from another replica via pubsub. A wake during a running
   * cycle makes the loop run once more instead of starting a second loop.
   */
  wake(): void {
    if (!this.#started || this.#stopping) return;
    this.#wakeRequested = true;
    if (this.#loop) return;
    this.#clearTimer();
    this.#loop = this.#runLoop();
  }

  /**
   * A run is stepping on a bound session thread. Interactive runs queue no
   * work, so without this an idle loop would never see them and the trailing
   * reconcile for results they leave behind would not happen. Each step keeps
   * the loop active for one reconcile interval; only the first step after a
   * settled pass wakes it, since an owed pass already rechecks every interval.
   */
  noteBoundThreadRun(): void {
    if (!this.#reconcileToolResults) return;
    this.#lastBoundThreadRunAt = Date.now();
    if (this.#reconcileOwed) return;
    this.#reconcileOwed = true;
    this.wake();
  }

  /** Run slots this process holds now, out of its cap. Per process: other replicas keep their own. */
  runSlots(): { inUse: number; cap: number } {
    return { inUse: this.#runInFlight.size, cap: this.#maxInFlight };
  }

  async runOnce(now = new Date()): Promise<void> {
    void this.#maybeSweepStaleBindings(now);
    this.#maybeReconcileToolResults(now);
    const { dispatches } = await this.#claimAndStart(now);
    await Promise.all(dispatches);
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #runLoop(): Promise<void> {
    let delay = POLL_MS;
    do {
      this.#wakeRequested = false;
      try {
        delay = await this.#cycle();
      } catch (error) {
        console.error('Factory decision dispatch cycle failed', sanitizeDispatchError(error));
        delay = POLL_MS;
      }
    } while (this.#wakeRequested && !this.#stopping);
    // No await between the loop exit and clearing #loop, so a wake() can
    // never land in between and be lost.
    this.#loop = undefined;
    if (this.#stopping) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.wake();
    }, delay);
    this.#timer.unref?.();
  }

  /** One loop cycle; returns the delay until the next one. */
  async #cycle(): Promise<number> {
    const now = new Date();
    // Fire-and-forget like the reconcile walk: the sweep reads every active
    // binding, so awaiting it would stretch the cycle as the active set grows.
    void this.#maybeSweepStaleBindings(now);
    // Tool results only come from runs, so the reconcile walk follows local
    // activity, plus one trailing pass after it stops.
    const active =
      this.#runInFlight.size > 0 ||
      this.#bookkeepingInFlight.size > 0 ||
      this.#mastraCode.anyRunning() ||
      (this.#lastBoundThreadRunAt !== undefined &&
        now.getTime() - this.#lastBoundThreadRunAt < this.#reconcileIntervalMs);
    if (!this.#reconcileToolResults) this.#reconcileOwed = false;
    else if (active) this.#reconcileOwed = true;
    if (this.#reconcileOwed && this.#maybeReconcileToolResults(now) && !active) this.#reconcileOwed = false;

    let full: boolean;
    try {
      const claimed = await this.#claimAndStart(now);
      full = claimed.full;
      for (const dispatch of claimed.dispatches) {
        dispatch.catch(error => {
          console.error('Factory decision dispatch failed', sanitizeDispatchError(error));
        });
      }
    } catch (error) {
      console.error('Factory decision dispatch cycle failed', sanitizeDispatchError(error));
      return POLL_MS;
    }
    if (full || this.#runInFlight.size > 0 || this.#bookkeepingInFlight.size > 0) return POLL_MS;

    const dueTimes: number[] = [];
    if (this.#reconcileOwed) {
      dueTimes.push((this.#lastReconcileAt?.getTime() ?? 0) + this.#reconcileIntervalMs);
    }
    try {
      // Covers future retries and leases left behind by a crashed replica.
      const nextClaimableAt = await this.#storage.nextClaimableAt();
      if (nextClaimableAt) dueTimes.push(nextClaimableAt.getTime());
    } catch (error) {
      console.error('Factory decision dispatch cycle failed', sanitizeDispatchError(error));
      return POLL_MS;
    }
    return Math.max(POLL_MS, Math.min(Math.min(...dueTimes, Infinity) - Date.now(), IDLE_RECHECK_MS));
  }

  /**
   * Claims a batch and starts dispatches without awaiting their completion.
   * Dispatches can legitimately take minutes (skill kickoffs consume the
   * agent's run stream; binding preparation provisions sandboxes), so awaiting
   * them here would freeze the poll loop and starve every other queued
   * decision. In-flight records stay protected from re-claim by lease renewal.
   */
  async #claimAndStart(now: Date): Promise<{ dispatches: Array<Promise<void>>; full: boolean }> {
    let full = false;
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const dispatches: Array<Promise<void>> = [];
    // Run slots are held for whole agent runs (minutes), so bookkeeping that
    // only mirrors the board is claimed from its own pool and never waits
    // behind them.
    const runCapacity = this.#maxInFlight - this.#runInFlight.size;
    if (runCapacity > 0) {
      const limit = Math.min(BATCH_SIZE, runCapacity);
      // Starts are claimed before deferred decisions: a pending start is a user
      // waiting on a brand-new session, while a deferred decision is a background
      // continuation of one that is already running. A deep decision queue must
      // never starve new sessions out of the tick.
      const starts = await this.#storage.claimPendingStarts({
        ownerId: this.#ownerId,
        now,
        leaseExpiresAt,
        limit,
      });
      const decisionsLimit = limit - starts.length;
      full = decisionsLimit <= 0;
      const decisions =
        decisionsLimit > 0
          ? await this.#storage.claimDeferredDecisions({
              ownerId: this.#ownerId,
              now,
              leaseExpiresAt,
              limit: decisionsLimit,
              decisionFilter: isRunBearingDecision,
            })
          : [];
      full ||= starts.length + decisions.length >= limit;
      dispatches.push(
        ...starts.map(start => this.#track(this.#runInFlight, this.#dispatchPendingStart(start, now))),
        ...decisions.map(decision => this.#track(this.#runInFlight, this.#dispatchDecision(decision, now))),
      );
    }
    const bookkeepingCapacity = BOOKKEEPING_MAX_IN_FLIGHT - this.#bookkeepingInFlight.size;
    if (bookkeepingCapacity > 0) {
      const limit = Math.min(BATCH_SIZE, bookkeepingCapacity);
      const decisions = await this.#storage.claimDeferredDecisions({
        ownerId: this.#ownerId,
        now,
        leaseExpiresAt,
        limit,
        decisionFilter: isBookkeepingDecision,
      });
      full ||= decisions.length >= limit;
      dispatches.push(
        ...decisions.map(decision => this.#track(this.#bookkeepingInFlight, this.#dispatchDecision(decision, now))),
      );
    }
    return { dispatches, full };
  }

  /**
   * Throttled, coalesced, non-blocking bound-thread reconcile: dispatch
   * claiming never waits behind cursor + message reads, and overlapping runs
   * are skipped while one is still in flight.
   */
  #maybeReconcileToolResults(now: Date): boolean {
    if (!this.#reconcileToolResults || this.#reconcileInFlight) return false;
    if (this.#lastReconcileAt && now.getTime() - this.#lastReconcileAt.getTime() < this.#reconcileIntervalMs) {
      return false;
    }
    this.#lastReconcileAt = now;
    const run = this.#reconcileToolResults()
      .catch(error => {
        console.error('Factory tool-result reconcile failed', sanitizeDispatchError(error));
      })
      .finally(() => {
        this.#reconcileInFlight = undefined;
      });
    this.#reconcileInFlight = run;
    this.#track(this.#backgroundInFlight, run);
    return true;
  }

  /** Slow-cadence revocation of leaked/legacy bindings; failures never block the claim path. */
  async #maybeSweepStaleBindings(now: Date): Promise<void> {
    // The first tick only anchors the cadence: sweeping at boot would race the
    // startup reconcile that is still draining trailing tool results.
    if (!this.#lastStaleBindingSweepAt) {
      this.#lastStaleBindingSweepAt = now;
      return;
    }
    if (now.getTime() - this.#lastStaleBindingSweepAt.getTime() < this.#staleBindingSweepIntervalMs) return;
    this.#lastStaleBindingSweepAt = now;
    try {
      const revoked = await this.#storage.revokeStaleRunBindings({
        olderThan: new Date(now.getTime() - this.#staleBindingTtlMs),
        now,
        // A run parked on a person, or resumed after one answered, is alive however
        // old its binding is. The session must still be on the binding's thread: its
        // suspension and run state belong to that thread. Lookup failures revoke.
        keep: async binding => {
          try {
            // fork(claude-agent)
            if (await this.#onRuntimeSeam(binding)) {
              const seam = this.#runtimeSessions!;
              return seam.isRunning(binding.sessionId) || (await seam.awaitsPerson(binding.sessionId));
            }
            return await this.#mastraCode.holdsThread(binding.sessionId, binding.threadId);
          } catch {
            return false;
          }
        },
      });
      if (revoked > 0) console.info(`Factory stale-binding sweep revoked ${revoked} binding(s)`);
    } catch (error) {
      console.error('Factory stale-binding sweep failed', sanitizeDispatchError(error));
    }
  }

  #track(pool: Set<Promise<void>>, dispatch: Promise<void>): Promise<void> {
    pool.add(dispatch);
    void dispatch
      .catch(() => {})
      .then(() => {
        pool.delete(dispatch);
        // A settled dispatch frees capacity and may have queued a retry.
        if (pool !== this.#backgroundInFlight) this.wake();
      });
    return dispatch;
  }

  async #dispatchDecision(record: FactoryDeferredDecisionRecord, now: Date): Promise<void> {
    let executionCompleted = false;
    try {
      const decision = validateFactoryRuleDecision(record.decision, record.causalChain.length);
      if (decision.type === 'reject') throw new Error('Deferred Factory decisions cannot reject.');
      if (await this.#needsApproval(record, decision)) {
        const proposed = await this.#storage.proposeDeferredDecision(leaseIdentity(record, this.#ownerId), new Date());
        if (!proposed) throw new Error('Factory decision lease was lost before approval could be requested.');
        return;
      }
      await this.#supersedeProposals(record, decision);
      // A first claim cannot have delivered its kickoff yet, so it may say `queued` right
      // away. A re-claim may find the run already going; it says `queued` only once the
      // replay guard proves the kickoff never landed.
      if (record.attempts <= 1) await this.#reviewQueuedOnce(record, decision);
      await this.#withLease(
        async leaseExpiresAt =>
          this.#storage.renewDeferredDecisionLease(leaseIdentity(record, this.#ownerId), leaseExpiresAt),
        async () => this.#executeDecision(record, decision),
      );
      executionCompleted = true;
      const completed = await this.#storage.completeDeferredDecision(leaseIdentity(record, this.#ownerId), new Date());
      if (!completed) throw new Error('Factory decision lease was lost before completion.');
      // Only an attempt that saw the run end may say it finished: the one that watched
      // it, or a re-claim that found the landed run already over (its worker was lost).
      if (this.#reviewWatched.has(record) || this.#reviewReplayed.has(record)) {
        await this.#reviewStatus(record, decision, {
          phase: 'completed',
          endedAt: new Date(),
          ...(this.#reviewReplayed.has(record) ? { replayed: true } : {}),
        });
      }
    } catch (error) {
      if (error instanceof FactoryDecisionSuperseded) {
        await this.#storage.supersedeLeasedDecision(leaseIdentity(record, this.#ownerId), new Date());
        await this.#reviewStatus(record, record.decision, { phase: 'cancelled', endedAt: new Date() });
        return;
      }
      if (error instanceof FactoryDecisionPostponed) {
        await this.#storage.postponeDeferredDecision(
          leaseIdentity(record, this.#ownerId),
          new Date(now.getTime() + POSTPONE_MS),
          new Date(),
        );
        return;
      }
      const failureCode = factoryDispatchFailureCode(error);
      const terminal = isTerminalFailure(record.attempts, failureCode);
      const failed = await this.#storage.failDeferredDecision({
        ...leaseIdentity(record, this.#ownerId),
        now: new Date(),
        availableAt: retryAt(now, record.attempts),
        lastError: sanitizeDispatchError(error),
        failureCode,
        terminal,
        advanceDeliveryGeneration: !executionCompleted,
      });
      if (terminal && failed) await this.#supersedeFailureOnSettledCard(failed);
      // A re-claim that failed before proving its kickoff never landed may be racing
      // an earlier attempt's live run; only a terminal failure may speak over it.
      if (terminal || this.#reviewQueued.has(record)) {
        await this.#reviewStatus(failed ?? record, record.decision, {
          phase: terminal ? 'failed' : 'retrying',
          endedAt: new Date(),
          reason: factoryDispatchFailureMetadata(failureCode).label,
        });
      }
    }
  }

  /**
   * An earlier attempt's kickoff already landed, so this attempt only has to
   * see that run end before a review's status can be finalized. The open-run
   * wait covers runs in the ledger; a run that landed but died before
   * registering there can still be live in this process, so wait it out too.
   */
  async #replayLanded(
    record: FactoryDeferredDecisionRecord,
    decision: unknown,
    session: Pick<DispatcherSession, 'subscribe'>,
    runStillActive: () => boolean,
  ): Promise<void> {
    if (!(await this.#isReviewRun(record, decision))) return;
    if (runStillActive()) {
      const run = watchRun(session, {
        timeoutMs: this.#skillCompletionObservationTimeoutMs,
        label: 'Factory skill run',
        runStillActive,
      });
      try {
        if (runStillActive()) await run.wait();
      } finally {
        run.close();
      }
    }
    this.#reviewReplayed.add(record);
  }

  /**
   * Holds the goal a phase's run pursues on the session's thread, and names it on the card so
   * leaving the phase ends it. Keyed on the decision: a retry finds the goal already held.
   */
  async #setPhaseGoal(
    record: FactoryDeferredDecisionRecord,
    goal: { objective: string; maxRuns?: number },
    session: BoundDispatcherSession,
    binding: FactoryRunBindingRecord,
  ): Promise<GoalObjectiveRecord> {
    // The phase this run is for, read before the goal exists (the kickoff was checked against it):
    // reading it afterwards could stamp the phase the card moved to meanwhile.
    const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    const phaseKey = item?.stages.length === 1 ? item.stages[0] : undefined;
    const objective = await startPhaseGoal(session.machinery.getAgent(), {
      threadId: binding.threadId,
      resourceId: binding.resourceId,
      goalId: record.id,
      objective: goal.objective,
      maxRuns: goal.maxRuns,
      // Factory has no judge setting of its own: the session's model judges its goal.
      judgeModelId: session.model.get() || undefined,
    });
    if (!objective) {
      throw new FactoryDispatchError('run_configuration_invalid', 'The Factory session has no storage to hold a goal.');
    }
    if (!item || !phaseKey) return objective;
    const stamp = { phaseKey, goalId: record.id, threadId: binding.threadId, sessionId: binding.sessionId };
    if (phaseGoalOf(item.metadata)?.goalId !== record.id) {
      await this.#storage.update({
        orgId: record.orgId,
        id: item.id,
        userId: 'factory',
        patch: { metadata: { [PHASE_GOAL_METADATA_KEY]: stamp } },
      });
    }
    // A move that committed before the stamp landed found no goal to end: end it here instead.
    const after = await this.#storage.get({ orgId: record.orgId, id: item.id });
    if (after?.stages.length !== 1 || after.stages[0] !== phaseKey) {
      await endPhaseGoal(stamp, { agentFor: async () => session.machinery.getAgent(), store: async () => undefined });
      throw new FactoryDecisionSuperseded();
    }
    return objective;
  }

  /**
   * Shows the goal in the thread once its run has the kickoff. A goal whose reminder never landed
   * is paused rather than left judging a run nobody was told about; the retry resumes it.
   */
  async #remindPhaseGoal(
    record: FactoryDeferredDecisionRecord,
    goal: GoalObjectiveRecord,
    session: BoundDispatcherSession,
    binding: FactoryRunBindingRecord,
    requestContext: RequestContext,
  ): Promise<void> {
    const reminderId = `${record.id}:goal`;
    if ((await session.thread.listActiveMessages()).some(message => message.id === reminderId)) return;
    const agent = session.machinery.getAgent();
    if (goal.status === 'paused') await agent.updateObjectiveOptions({ threadId: binding.threadId, status: 'active' });
    try {
      const settled = await session.sendSignal(
        {
          id: reminderId,
          type: 'system-reminder',
          contents: goal.objective,
          attributes: { type: 'goal' },
          metadata: { goalId: goal.id, goalMaxTurns: goal.maxRuns, judgeModelId: goal.judgeModelId },
        },
        { requestContext, requireDelivery: true },
      ).accepted;
      if (settled.action !== 'wake' && settled.action !== 'deliver') {
        throw new FactoryDispatchError(
          'notification_delivery_failed',
          `Factory goal reminder did not reach the agent (${String(settled.action)}).`,
        );
      }
    } catch (error) {
      await agent.updateObjectiveOptions({ threadId: binding.threadId, status: 'paused' });
      throw error;
    }
  }

  /** A retried decision whose kickoff already landed: make sure its goal is held and shown. */
  async #startPhaseGoal(
    record: FactoryDeferredDecisionRecord,
    goal: { objective: string; maxRuns?: number },
    session: BoundDispatcherSession,
    binding: FactoryRunBindingRecord,
    requestContext: RequestContext,
  ): Promise<void> {
    const objective = await this.#setPhaseGoal(record, goal, session, binding);
    await this.#remindPhaseGoal(record, objective, session, binding, requestContext);
  }

  /**
   * A pull request review run: the only runs that keep a status comment on the pull request. A
   * review-seat run of the skill the card's board self-reviews with checks the builder's own work
   * and reviews no pull request, even on a card that carries one.
   */
  async #isReviewRun(record: FactoryDeferredDecisionRecord, decision: unknown): Promise<boolean> {
    const run = reviewSeatSkill(decision);
    if (!run) return false;
    const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    if (!item) return true;
    const board = (await this.#boards.load(record)).get(boardForWorkItem(item));
    const selfReview = boardFlow(board).selfReview;
    const phase = selfReview === undefined ? undefined : board?.phases[selfReview];
    return phase?.kind !== 'working' || phase.runner.skill !== run.skillName;
  }

  async #reviewQueuedOnce(record: FactoryDeferredDecisionRecord, decision: unknown): Promise<void> {
    if (this.#reviewQueued.has(record)) return;
    this.#reviewQueued.add(record);
    await this.#reviewStatus(record, decision, { phase: 'queued' });
  }

  /** Best-effort: a status comment is never worth failing or delaying the review it describes. */
  async #reviewStatus(
    record: FactoryDeferredDecisionRecord,
    decision: unknown,
    step: Pick<FactoryReviewStatusEvent, 'phase' | 'startedAt' | 'endedAt' | 'reason'>,
  ): Promise<void> {
    const report = this.#reportReviewStatus;
    if (!report || !record.workItemId) return;
    try {
      if (!(await this.#isReviewRun(record, decision))) return;
    } catch (error) {
      console.warn('Factory review status update failed', sanitizeDispatchError(error));
      return;
    }
    const event: FactoryReviewStatusEvent = {
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      workItemId: record.workItemId,
      run: record.id,
      requestedAt: record.createdAt,
      generation: record.deliveryGeneration,
      attempt: record.attempts,
      ...step,
    };
    // Writes for one run go out in order even when the run stops waiting on a
    // slow one, so an earlier step can never land on top of a later one.
    const run = this.#reviewStatusRuns.get(record.id) ?? {
      tail: Promise.resolve(),
      issued: 0,
      landed: 0,
      latest: event,
    };
    this.#reviewStatusRuns.set(record.id, run);
    const previous = run.tail;
    const seq = ++run.issued;
    run.latest = event;
    const send = (next: FactoryReviewStatusEvent) =>
      report(next).catch(error => {
        console.warn('Factory review status update failed', sanitizeDispatchError(error));
      });
    // A write that never settles holds the next one back for one timeout, not forever.
    let waited: ReturnType<typeof setTimeout> | undefined;
    const turn = Promise.race([
      previous,
      new Promise<void>(resolve => {
        waited = setTimeout(resolve, REVIEW_STATUS_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(waited));
    const delivered = turn.then(async () => {
      await send(event);
      // This write outlived its wait and a newer one landed first: it may have
      // put an older step back on the comment, so restate the newest one.
      if (run.landed > seq) await send(run.latest);
      run.landed = Math.max(run.landed, seq);
    });
    run.tail = delivered;
    void delivered.then(() => {
      if (run.tail === delivered && run.landed >= run.issued && this.#reviewStatusRuns.get(record.id) === run) {
        this.#reviewStatusRuns.delete(record.id);
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), REVIEW_STATUS_TIMEOUT_MS);
    });
    try {
      if ((await Promise.race([delivered, timedOut])) === 'timeout') {
        console.warn(`Factory review status update (${step.phase}) still pending; continuing the run without it`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Terminal cleanup ran before this failure landed, so it never saw this row. */
  async #supersedeFailureOnSettledCard(record: FactoryDeferredDecisionRecord): Promise<void> {
    if (!record.workItemId) return;
    try {
      const item = await this.#storage.get({ orgId: record.orgId, id: record.workItemId });
      if (!item || workItemPhaseSemantics(await this.#boards.load(record), item)?.kind !== 'terminal') return;
      await this.#storage.supersedeDecisionsForWorkItem({
        orgId: record.orgId,
        factoryProjectId: record.factoryProjectId,
        workItemId: record.workItemId,
        supersededAt: new Date(),
      });
    } catch (error) {
      // Best-effort: the row stays failed until someone clears it from the card.
      console.error('Factory settled-card supersede failed', sanitizeDispatchError(error));
    }
  }

  /**
   * A proposal is a question: "should this run start?" Once that run is
   * starting anyway — because a person approved a later copy, or armed the item
   * — the question has been answered and the card must stop asking it. Left
   * alone the badge outlives the work it describes, and the one affordance that
   * means "the loop is stopped, answer this" cries wolf.
   */
  async #supersedeProposals(record: FactoryDeferredDecisionRecord, decision: FactoryCommitDecision): Promise<void> {
    if (decision.type !== 'invokeSkill' || !record.workItemId) return;
    try {
      await this.#storage.supersedeDecisionsForWorkItem({
        orgId: record.orgId,
        factoryProjectId: record.factoryProjectId,
        workItemId: record.workItemId,
        role: decision.role,
        supersededAt: new Date(),
      });
    } catch (error) {
      // Best-effort: a stale badge is not worth failing the run it describes.
      console.error('Factory proposal supersede failed', sanitizeDispatchError(error));
    }
  }

  // Effects a person owns: starting a run (compute + code execution), and an
  // external event pulling a card back into a working lane. The board decides
  // which of them start on their own: a phase with `autoStart` (and a card its
  // `autoStartWhen` matches). Anything else waits for a person.
  async #needsApproval(record: FactoryDeferredDecisionRecord, decision: FactoryCommitDecision): Promise<boolean> {
    if (record.approvedAt !== null) return false;
    // fork(claude-agent): a move the rule held for a person (an auto-fix past its attempts).
    if (decision.type === 'transition' && decision.consent === 'required') return true;
    const boards = await this.#boards.load(record);
    if (!requestsConsent(boards, record, decision)) return false;
    const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    if (!item) return true;
    // Once someone starts a card, the runs that carry it to review are that same request continuing.
    if (item.autonomyArmedAt != null) return false;
    if (reviewsFactoryAuthoredCode(boards, item, decision)) return false;
    return !startsInAutoPhase(boards, item, decision);
  }

  async #executeDecision(record: FactoryDeferredDecisionRecord, decision: FactoryCommitDecision): Promise<void> {
    const nextChain: FactoryRuleCausalEntry[] = [
      ...(record.causalChain as FactoryRuleCausalEntry[]),
      { ingressId: record.idempotencyKey, decisionType: decision.type },
    ];
    if (nextChain.length > MAX_FACTORY_RULE_CAUSAL_DEPTH) throw new Error('Factory rule causal depth exceeded.');

    switch (decision.type) {
      case 'transition': {
        if (decision.event) await this.#routeEvent(record, decision.event, nextChain, decision);
        else await this.#applyTransition(record, decision, nextChain);
        return;
      }
      case 'routeEvent': {
        await this.#routeEvent(record, decision.event, nextChain);
        return;
      }
      case 'upsertLinkedWorkItem': {
        await this.#upsertLinkedItem(record, decision, nextChain);
        return;
      }
      case 'invokeSkill': {
        // A retry for a role the card has already been handed past cannot win:
        // no seat can be minted for it, and the work it was for is done.
        // Checked before a seat is prepared: a stale run must not mint one for a role the card left.
        if (
          (await this.#roleSuperseded(record, decision.role)) ||
          (await this.#decisionOvertaken(record, decision.role))
        ) {
          throw new FactoryDecisionSuperseded();
        }
        const binding = await this.#requireOrPrepareBinding(record, decision.role);
        // fork(claude-agent): every kickoff runs through the seam: on Claude Agent's adapter when the
        // session runs there, else on Mastra Code's, which keeps its own objective loop (`ownsGoal`).
        const seam = (await this.#onRuntimeSeam(binding)) ? this.#runtimeSessions! : this.#mastraCode;
        await this.#withBindingSkillRun(binding.id, () => this.#invokeSkillOnSeam(record, decision, binding, seam));
        return;
      }
      case 'sendMessage': {
        const binding = await this.#messageBinding(record, decision);
        // Nobody live on the card means nobody to tell, not a failure to retry.
        if (!binding) return;
        const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
        const startedBy = item?.sessions[binding.role]?.startedBy;
        if (!startedBy) throw new Error(`Factory binding ${binding.id} has no authenticated session owner.`);
        // fork(claude-agent)
        if (await this.#onRuntimeSeam(binding)) {
          await this.#messageOnSeam(binding, startedBy, record.orgId, {
            text: decision.message,
            source: 'rule-message',
            wake: (decision.idleBehavior ?? 'wake') === 'wake',
          });
          return;
        }
        await this.#primeCredentials?.({ orgId: record.orgId, userId: startedBy });
        await this.#messageOnSeam(
          binding,
          startedBy,
          record.orgId,
          {
            text: decision.message,
            source: 'rule-message',
            wake: (decision.idleBehavior ?? 'wake') === 'wake',
            priority: decision.priority ?? 'high',
            sourceId: record.id,
            idempotencyKey: record.idempotencyKey,
            thread: { id: binding.threadId, resourceId: binding.resourceId },
          },
          this.#mastraCode,
        );
        return;
      }
      case 'signalActivity': {
        await this.#signalActivity(record, decision);
        return;
      }
      case 'dismissStaleReviews': {
        if (!this.#dismissStaleReviews) throw new Error('GitHub review dismissal is not configured.');
        await this.#dismissStaleReviews(decision);
        return;
      }
      case 'notify': {
        const selected = await this.#requireBinding(record);
        if (
          (await this.#roleSuperseded(record, selected.role)) ||
          (await this.#decisionOvertaken(record, selected.role))
        ) {
          throw new FactoryDecisionSuperseded();
        }
        const binding = await this.#requireOrPrepareBinding(record, selected.role, selected.id);
        // A notification can wake the idle session, so it runs as the session's
        // owner like any other Factory-started run, never as nobody.
        const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
        const startedBy = item?.sessions[binding.role]?.startedBy;
        if (!startedBy) throw new Error(`Factory binding ${binding.id} has no authenticated session owner.`);
        // fork(claude-agent): a notification waits for the session's next turn, as an idle Mastra Code session persists it.
        if (await this.#onRuntimeSeam(binding)) {
          const text = decision.body ? `${decision.title}\n\n${decision.body}` : decision.title;
          await this.#messageOnSeam(binding, startedBy, record.orgId, {
            text,
            source: 'rule-notification',
            wake: false,
          });
          return;
        }
        await this.#primeCredentials?.({ orgId: record.orgId, userId: startedBy });
        const session = await this.#requireSession(binding, { userId: startedBy, orgId: record.orgId });
        const requestContext = factoryRequestContext({ session, binding, userId: startedBy, orgId: record.orgId });
        await awaitNotification(() =>
          session.sendNotificationSignal(
            {
              source: 'factory',
              kind: 'rule-notification',
              summary: decision.title,
              payload: { body: decision.body, level: decision.level },
              sourceId: record.id,
              dedupeKey: record.idempotencyKey,
            },
            { requestContext },
          ),
        );
      }
    }
  }

  async #upsertLinkedItem(
    record: FactoryDeferredDecisionRecord,
    requested: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>,
    causalChain: FactoryRuleCausalEntry[],
  ): Promise<void> {
    if (
      this.#factoryProjectExists &&
      !(await this.#factoryProjectExists({ orgId: record.orgId, factoryProjectId: record.factoryProjectId }))
    ) {
      return;
    }
    // A lost completion acknowledgement must not reinterpret a committed
    // materialization against a replacement installation.
    const existing = await this.#storage.getByProjectSource({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      source: externalSourceForDecision(requested),
    });
    // A pull request attached to its issue's card is filed already. Re-filing it (a replayed
    // or swept "opened") must not write its facts onto the card's primary issue source. A
    // reopen is the one fact it brings: the attached source is open again.
    if (
      existing &&
      externalSourceKey(existing.externalSource) !== externalSourceKey(externalSourceForDecision(requested))
    ) {
      const source = externalSourceForDecision(requested);
      const facts = workItemProviderAdapter(source).toSource(source, requested.metadata ?? null);
      if (facts?.state === 'open') {
        await this.#storage.syncWorkItemSource({
          orgId: record.orgId,
          factoryProjectId: record.factoryProjectId,
          provider: facts.provider,
          externalId: facts.externalId,
          patch: current =>
            current.state === 'closed' || current.state === 'merged'
              ? { state: facts.state, metadata: { ...current.metadata, ...facts.metadata } }
              : null,
        });
      }
      return;
    }
    if (!existing && requested.attachTo) {
      // A card takes a pull request when its board reviews pull requests; elsewhere the pull
      // request is filed as its own card.
      // fork(claude-agent): ...or when the card's own run opened it, whatever its board: the card's
      // handoff to review needs it there. Only the card the decision is committed against can
      // claim a pull request as its own.
      const attachBoards = await this.#boards.load(record);
      const ownPullRequest =
        requested.attachTo.ownPullRequest === true && record.workItemId === requested.attachTo.workItemId;
      if (
        await this.#attachLinkedItem(record, requested, requested.attachTo.workItemId, causalChain, card =>
          ownPullRequest || cardBoardFlow(attachBoards, card).pullRequestReview !== undefined
            ? { phase: null }
            : undefined,
        )
      ) {
        return;
      }
    }
    if (!existing && requested.closesIssue && (await this.#joinClosedIssue(record, requested, causalChain))) return;
    const materializedHere = existing?.metadata?.[FACTORY_RULE_MATERIALIZATION_KEY] === record.idempotencyKey;
    // Filing the card *was* the placement, so a retry of the same decision has
    // nothing left to apply — and must not drag a card that has since moved
    // back down to the stage this decision filed it at.
    if (materializedHere && requested.skipRules === true) return;
    const boards = await this.#boards.load(record);
    // Intake routes place only a card this decision files (or is still filing,
    // on a retry); a card already on the board stays where it is.
    const decision = !existing
      ? await this.#routeArrival(record, requested, boards)
      : materializedHere
        ? await this.#resumeRoutedCard(record, existing, requested, boards)
        : this.#keepRoutedCard(existing, requested, boards);
    if (materializedHere) {
      for (const suffix of ['destination', 'initial-entry']) {
        const replay = await this.#storage.getTransitionResultByIngress(
          record.orgId,
          record.factoryProjectId,
          `decision:${record.idempotencyKey}:${existing.id}:${suffix}`,
        );
        if (replay?.status === 'accepted' && replay.stage === decision.stage) return;
      }
    }
    assertFactoryDecisionTarget(decision, boards);
    const definition = boards.get(decision.board);
    if (!definition) throw new Error('Factory decision target board is not installed.');
    const initialPhase = definition.initialPhase;
    // `skipRules` files the card at the stage the decision names, as its first
    // entry, and runs none of the board's phase rules. Without it the card
    // enters through the board's initial phase and transitions from there, so
    // arrival and destination-entry rules both run.
    const skipRules = decision.skipRules === true;
    const entryStage = skipRules ? decision.stage : initialPhase;
    const parentWorkItemId =
      record.workItemId ??
      (await this.#resolveLinkedWorkItemParentId?.({
        orgId: record.orgId,
        factoryProjectId: record.factoryProjectId,
        decision,
      })) ??
      null;
    let result: UpsertWorkItemResult = await this.#storage.upsert({
      orgId: record.orgId,
      userId: 'factory-rule-dispatcher',
      factoryProjectId: record.factoryProjectId,
      input: {
        externalSource: externalSourceForDecision(decision),
        parentWorkItemId,
        title: decision.title,
        ...(decision.description ? { description: decision.description } : {}),
        board: decision.board,
        stages: [entryStage],
        sessions: {},
        metadata: { ...decision.metadata, [FACTORY_RULE_MATERIALIZATION_KEY]: record.idempotencyKey },
      },
      reuseMode: 'preserve',
    });
    const itemBoard = boardForWorkItem(result.item);
    // A pull request's own card already on another board that reviews pull requests (the retired
    // Review board, for a project still using it) stays there: filing its pull request again acts
    // on it where it sits, in that board's own review phase.
    const itemFlow = itemBoard === decision.board ? undefined : boardFlow(boards.get(itemBoard));
    const keptReview = isPullRequestCard({ source: workItemSource(result.item.externalSource) })
      ? itemFlow?.pullRequestReview
      : undefined;
    const board = keptReview === undefined ? decision.board : itemBoard;
    const placeStage =
      keptReview !== undefined && decision.stage === boardFlow(definition).pullRequestReview
        ? keptReview
        : decision.stage;
    if (!skipRules && itemBoard !== board) {
      throw new Error(`The work item belongs to board "${itemBoard}", not "${board}".`);
    }
    // A re-evaluation for an already-filed card (poll/reconcile re-emitting
    // "opened") resolves the card itself as the triggering item; it is not
    // its own parent.
    if (!result.item.parentWorkItemId && parentWorkItemId && parentWorkItemId !== result.item.id) {
      const item = await this.#storage.setParentWorkItemIfMissing({
        orgId: record.orgId,
        id: result.item.id,
        userId: 'factory-rule-dispatcher',
        parentWorkItemId,
      });
      if (item) result = { ...result, item };
    }
    // A `skipRules` decision is a placement and nothing else: the backfill would
    // otherwise walk the arrival decision's facts back onto an existing card,
    // restamping trust the sweep deliberately left unanswered.
    if (!result.created && !skipRules) {
      // Backfill source facts (e.g. sourceCreatedAt) that older cards were filed
      // without. Fill-only: never overwrite, and never adopt the card as
      // materialized by this decision.
      const providerKeys = workItemProviderAdapter(result.item.externalSource).providerMetadataKeys;
      const missing = Object.fromEntries(
        Object.entries(decision.metadata ?? {}).filter(
          ([key]) =>
            key !== FACTORY_RULE_MATERIALIZATION_KEY &&
            (providerKeys.includes(key) ? result.item.workItem.metadata?.[key] : result.item.metadata?.[key]) ===
              undefined,
        ),
      );
      if (Object.keys(missing).length > 0) {
        const filled = await this.#storage.syncCard({
          orgId: record.orgId,
          id: result.item.id,
          userId: 'factory-rule-dispatcher',
          patch: { metadata: missing },
          fillOnly: true,
        });
        if (filled) result = { ...result, item: filled.item };
      }
    }
    if (skipRules) {
      // Creation already filed the card at `stage`. An existing card — one a
      // reconcile pass files again, say — is placed there the same way, through
      // a cross-board relocation, so no phase rule runs for it and no transition
      // is recorded.
      // Another decision of the same delivery (a pull request attaching to this card, say) can
      // change the card in between; a placement skipped for that reason is retried on a fresh read.
      let item: Card | null = result.created ? null : result.item;
      for (let attempt = 0; item && attempt < 3; attempt += 1) {
        const outcome = await moveCardToBoard({
          workItems: this.#storage,
          boardRegistry: boards,
          userId: 'factory-rule-dispatcher',
          item,
          targetBoard: board,
          targetStage: placeStage,
        });
        if (outcome !== 'skipped') break;
        const fresh = await this.#storage.get({ orgId: record.orgId, id: item.id });
        item = fresh && fresh.revision !== item.revision ? fresh : null;
      }
      return;
    }
    const materializedByDecision = result.item.metadata?.[FACTORY_RULE_MATERIALIZATION_KEY] === record.idempotencyKey;
    if (!materializedByDecision && (decision.stage === initialPhase || !result.item.stages.includes(initialPhase)))
      return;

    let expectedRevision = result.item.revision;
    if (materializedByDecision) {
      const initial = await this.#transitionService.transition({
        orgId: record.orgId,
        factoryProjectId: record.factoryProjectId,
        workItemId: result.item.id,
        board,
        stage: initialPhase,
        expectedRevision,
        actor: deferredActor(record),
        ingress: { type: 'rule', identity: `decision:${record.idempotencyKey}:${result.item.id}:initial-entry` },
        cause: 'linked_item_materialized',
        causalChain,
        initialEntry: true,
      });
      if (initial.status === 'rejected') {
        if (result.created)
          await this.#storage.delete({ orgId: record.orgId, id: result.item.id, purgeRuleState: false });
        throw new Error(`${initial.code}: ${initial.reason}`);
      }
      expectedRevision = initial.revision;
    }
    if (decision.stage === initialPhase) return;

    const moved = await this.#transitionService.transition({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      workItemId: result.item.id,
      board,
      stage: decision.stage,
      expectedRevision,
      actor: { type: 'system', id: 'factory-rule-dispatcher' },
      ingress: { type: 'rule', identity: `decision:${record.idempotencyKey}:${result.item.id}:destination` },
      cause: materializedByDecision ? 'linked_item_materialized' : 'linked_item_reconciled',
      causalChain,
    });
    if (moved.status === 'rejected') throw new Error(`${moved.code}: ${moved.reason}`);
  }

  /**
   * Files a pull or merge request on the existing card `workItemId`, as one more source, when
   * `admit` takes the card as it is now; the card then moves to the phase `admit` names when its
   * board allows it. Returns false when the card can't take it (gone, finished, a pull request's
   * own card, refused by `admit`, or another card took the record first), so the caller files the
   * record as usual. `admit` runs again on a fresh read whenever the card changed in between.
   */
  async #attachLinkedItem(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>,
    workItemId: string,
    causalChain: FactoryRuleCausalEntry[],
    admit: (card: Card) => { phase: string | null } | undefined,
  ): Promise<boolean> {
    // A dry run of the work item split has no sources table to attach to: the pull request
    // gets its own card, as before.
    if (this.#storage.legacyMode) return false;
    const boards = await this.#boards.load(record);
    let attached: { card: Card; phase: string | null } | undefined;
    for (let attempt = 0; attempt < 3 && !attached; attempt++) {
      const card = await this.#storage.get({ orgId: record.orgId, id: workItemId });
      if (
        !card ||
        card.factoryProjectId !== record.factoryProjectId ||
        isTerminalWorkItem(boards, card) ||
        isPullRequestCard({ source: workItemSource(card.externalSource) })
      ) {
        return false;
      }
      const admitted = admit(card);
      if (!admitted) return false;
      try {
        // At the revision `admit` read: work starting or another pull request landing in between
        // sends the record round again.
        const result = await this.#storage.attachSource({
          orgId: record.orgId,
          id: card.id,
          source: externalSourceForDecision(decision),
          metadata: decision.metadata ?? null,
          expectedRevision: card.revision,
        });
        if (!result) return false;
        attached = { card: result.item, phase: admitted.phase };
      } catch (error) {
        if (error instanceof WorkItemSourceConflictError) return false;
        if (error instanceof WorkItemUpdateConflictError) continue;
        throw error;
      }
    }
    if (!attached) return false;
    const { card, phase } = attached;
    const stage = card.stages.length === 1 ? card.stages[0] : undefined;
    const board = boards.get(boardForWorkItem(card));
    if (!phase || !stage || stage === phase) return true;
    if (!board?.allowsTransition(stage, phase)) {
      console.warn(
        `[factory] attached a pull request to ${card.id}, which stays in ${stage}: its board has no move to ${phase}`,
      );
      return true;
    }
    const moved = await this.#transitionService.transition({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      workItemId: card.id,
      board: board.id,
      stage: phase,
      expectedRevision: card.revision,
      actor: { type: 'system', id: 'factory-rule-dispatcher' },
      ingress: { type: 'rule', identity: `decision:${record.idempotencyKey}:${card.id}:attach` },
      cause: 'linked_item_attached',
      causalChain,
    });
    // The pull request is on the card either way, and a retry would not move it.
    if (moved.status === 'rejected') {
      console.warn(
        `[factory] attached a pull request to ${card.id} but could not move it to ${phase}: ${moved.code}: ${moved.reason}`,
      );
    }
    return true;
  }

  /**
   * Joins a pull or merge request to the card of the issue it closes when the project's intake
   * routes say so: the first route matching the arrival, with the facts of that card as it is now,
   * is a joining one. Only an arrival the routes would place qualifies, and only from an author
   * with write access: no route can put an outsider's pull request on someone else's card.
   */
  async #joinClosedIssue(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>,
    causalChain: FactoryRuleCausalEntry[],
  ): Promise<boolean> {
    if (!authorTrusted(decision.metadata) || !this.#intakeRoutes || decision.skipRules === true) return false;
    if (record.workItemId !== null) return false;
    const boards = await this.#boards.load(record);
    const routes = await this.#intakeRoutes.listIntakeRoutes({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
    });
    if (routes.length === 0) return false;
    const arrival = cardRuleFacts({
      title: decision.title,
      metadata: decision.metadata ?? {},
      externalSource: externalSourceForDecision(decision),
    });
    return this.#attachLinkedItem(record, decision, decision.closesIssue!.workItemId, causalChain, card => {
      const route = resolveIntakeRoute(routes, { ...arrival, ...closedIssueRuleFacts(card) }, boards, card);
      return route?.type === 'join' ? { phase: route.phase } : undefined;
    });
  }

  /**
   * Places an arrival where the project's intake routes say: the first enabled route matching it,
   * else the default board's first phase. The board and phase an integration's rule named don't
   * count; only a decision placing the card outright (`skipRules`) keeps its own.
   */
  async #routeArrival(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>,
    boards: BoardRegistry,
  ): Promise<Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>> {
    if (!this.#intakeRoutes || decision.skipRules === true) return decision;
    // A card another card's rule files (a board's child card) goes where that
    // board put it; routes place only what arrives from outside.
    if (record.workItemId !== null) return decision;
    const routes = await this.#intakeRoutes.listIntakeRoutes({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
    });
    // A route can also test the issue a pull request closes, as it is now.
    const closedIssue = decision.closesIssue
      ? await this.#storage.get({ orgId: record.orgId, id: decision.closesIssue.workItemId })
      : null;
    const facts = {
      ...cardRuleFacts({
        title: decision.title,
        metadata: decision.metadata ?? {},
        externalSource: externalSourceForDecision(decision),
      }),
      ...(decision.closesIssue
        ? closedIssueRuleFacts(
            closedIssue &&
              closedIssue.factoryProjectId === record.factoryProjectId &&
              !isTerminalWorkItem(boards, closedIssue)
              ? closedIssue
              : undefined,
          )
        : {}),
    };
    const placement = resolveIntakePlacement(routes, facts, boards);
    if (!placement) {
      const fallback = intakeTarget(boards);
      return fallback ? { ...decision, board: fallback.board, stage: fallback.initialPhase } : decision;
    }
    return {
      ...decision,
      board: placement.board,
      stage: placement.phase,
      metadata: { ...decision.metadata, [INTAKE_ROUTE_METADATA_KEY]: placement.routeId },
    };
  }

  /**
   * A card an intake route placed stays on the route's board when its source is filed again
   * (a reconcile replaying "opened"): the decision lands
   * on the card's board at its first phase, so it only backfills facts and moves nothing.
   * An explicit placement (`skipRules`) still wins.
   */
  /**
   * A retry of the decision that filed `existing` finishes the filing where it started: on the
   * card's board, at the phase its route names now, or the board's first phase when the route was
   * deleted, disabled or re-pointed since. Routes are not re-run, so an edit cannot send the card
   * to a board it isn't on.
   */
  async #resumeRoutedCard(
    record: FactoryDeferredDecisionRecord,
    existing: Card,
    decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>,
    boards: BoardRegistry,
  ): Promise<Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>> {
    const routeId = existing.metadata?.[INTAKE_ROUTE_METADATA_KEY];
    if (typeof routeId !== 'string') return decision;
    const board = boards.get(boardForWorkItem(existing));
    if (!board) return decision;
    const routes = this.#intakeRoutes
      ? await this.#intakeRoutes.listIntakeRoutes({ orgId: record.orgId, factoryProjectId: record.factoryProjectId })
      : [];
    const route = routes.find(entry => entry.id === routeId && entry.enabled && entry.target.boardKey === board.id);
    return {
      ...decision,
      board: board.id,
      stage: landingPhase(board, route?.target.phaseKey),
      metadata: { ...decision.metadata, [INTAKE_ROUTE_METADATA_KEY]: routeId },
    };
  }

  #keepRoutedCard(
    existing: Card,
    decision: Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }>,
    boards: BoardRegistry,
  ): Extract<FactoryCommitDecision, { type: 'upsertLinkedWorkItem' }> {
    if (decision.skipRules === true || !placedByIntakeRoute(existing)) return decision;
    const board = boards.get(boardForWorkItem(existing));
    if (!board || board.id === decision.board) return decision;
    return { ...decision, board: board.id, stage: board.initialPhase };
  }
  /** Moves the card as a rule decided, then queues the decision's message for the card's session. */
  async #applyTransition(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'transition' }>,
    nextChain: FactoryRuleCausalEntry[],
  ): Promise<void> {
    const item = await this.#requireItem(record);
    const replay = await this.#storage.getTransitionResultByIngress(
      record.orgId,
      record.factoryProjectId,
      `decision:${record.idempotencyKey}`,
    );
    if (!replay) assertFactoryDecisionTarget(decision, await this.#boards.load(record), item.board ?? undefined);
    const result = await this.#transitionService.transition({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      workItemId: item.id,
      board: decision.board,
      stage: decision.stage,
      expectedRevision: item.revision,
      actor: record.approvedBy
        ? { type: 'human', id: record.approvedBy }
        : { type: 'system', id: 'factory-rule-dispatcher' },
      ingress: { type: 'rule', identity: `decision:${record.idempotencyKey}` },
      cause: 'rule_decision',
      causalChain: nextChain,
      ...(decision.reenter ? { reenter: true } : {}),
    });
    if (result.status === 'rejected') throw new Error(`${result.code}: ${result.reason}`);
    const transitionMessage = decision.message;
    if (!transitionMessage) return;
    // The message may wake an idle session and hold it for a whole agent
    // run, so it is queued as its own sendMessage decision for the run
    // pool; the stage change above never waits on run capacity. Keyed by
    // this decision, so a retry replays rather than queueing it twice.
    const moved = await this.#storage.get({ orgId: record.orgId, id: item.id });
    if (!moved) return;
    const messageKey = `${record.idempotencyKey}:message`;
    // Keyed by revision so a retry after a concurrent write commits under a
    // fresh identity at the item's new revision.
    const queued = await this.#storage.commitRuleEvaluation({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      workItemId: item.id,
      ingress: { identity: `decision:${messageKey}@${moved.revision}`, triggerType: 'transition.message' },
      configVersion: this.#transitionService.configVersion,
      expectedRevision: moved.revision,
      actor: record.actor ?? { type: 'system', id: 'factory-rule-dispatcher' },
      outcome: { status: 'accepted' },
      decisions: [
        {
          type: 'sendMessage',
          idempotencyKey: messageKey,
          message: transitionMessage.text,
          priority: 'high',
          idleBehavior: 'wake',
          ...(transitionMessage.role !== undefined ? { role: transitionMessage.role } : {}),
        },
      ],
      causalChain: nextChain,
      now: new Date(),
    });
    if (queued.status === 'missing') return;
    if (queued.status === 'stale') {
      throw new Error('Factory transition message was not queued: the work item changed concurrently.');
    }
    const queuedStatus = (queued.result as { status?: string }).status;
    if (queuedStatus !== 'accepted') {
      throw new Error(`Factory transition message was not queued: ${queuedStatus ?? 'unknown'}.`);
    }
  }

  /**
   * Moves a card where the project's intake routes send it on a status event. A move into a
   * working or resting phase waits for the run in flight on the card to end, going back to the
   * queue without holding a dispatch slot until it has; a move into a
   * terminal phase does not, so terminal cleanup stops that run at once, as a close always has.
   * A close moves only an unfinished card and a reopen only a finished one. When no route on the
   * card's board handles the event at all, the rule's own move (a board's `sourceClosed` phase)
   * applies instead; when one does but none matches, the card stays. A route's move is a system
   * move by the route: recorded in the card's history and audit, keyed so a replayed delivery
   * moves nothing twice.
   */
  async #routeEvent(
    record: FactoryDeferredDecisionRecord,
    event: BoardEventFacts,
    causalChain: FactoryRuleCausalEntry[],
    fallback?: Extract<FactoryCommitDecision, { type: 'transition' }>,
  ): Promise<void> {
    const identity = `event-route:${record.idempotencyKey}`;
    if (await this.#storage.getTransitionResultByIngress(record.orgId, record.factoryProjectId, identity)) return;
    if (await this.#statusEventOvertaken(record)) throw new FactoryDecisionSuperseded();
    const resolve = async () => {
      const item = await this.#requireItem(record);
      const board = (await this.#boards.load(record)).get(boardForWorkItem(item));
      if (!board) return undefined;
      const stage = item.stages.length === 1 ? item.stages[0] : undefined;
      const finished = stage !== undefined && board.isTerminal(stage);
      if (!eventMovesCard(event.type, finished)) return undefined;
      const routes = this.#intakeRoutes
        ? await this.#intakeRoutes.listIntakeRoutes({ orgId: record.orgId, factoryProjectId: record.factoryProjectId })
        : [];
      if (!routesHandleEvent(routes, event, board)) return { item, board, fallback: true as const };
      const route = resolveEventRoute(routes, event, cardRuleFacts(item), board, hasPullRequest(item));
      // A pull request event the rules already decided keeps that decision when no enabled route
      // takes the card: disabling or narrowing a route must not strand a merged card in review.
      if (!route)
        return fallback && isPullRequestEvent(event.type) ? { item, board, fallback: true as const } : undefined;
      // A route that agrees with the rule's own pull request move keeps it whole: its message, and
      // the re-entry that restarts a review in the phase the card already sits in.
      if (fallback && isPullRequestEvent(event.type) && route.phase === fallback.stage) {
        return { item, board, fallback: true as const };
      }
      if (stage === route.phase) return undefined;
      return { item, board, route };
    };
    const first = await resolve();
    if (!first) return;
    if ('fallback' in first) {
      if (fallback) await this.#applyTransition(record, fallback, causalChain);
      return;
    }
    if (!first.board.isTerminal(first.route.phase)) {
      const binding = await this.#findBinding(record);
      // A binding with no recorded owner never started a run, so it has none in flight.
      const startedBy = binding ? first.item.sessions[binding.role]?.startedBy : undefined;
      if (startedBy) await this.#primeCredentials?.({ orgId: record.orgId, userId: startedBy });
      const session =
        binding && startedBy ? await this.#findSession(binding, { userId: startedBy, orgId: record.orgId }) : undefined;
      // Checked again on the next claim: the card may have moved, or the routes changed, by then.
      if (binding && session && (await this.#hasRunInFlight(session, binding))) {
        throw new FactoryDecisionPostponed();
      }
    }
    const { item, board, route } = first;
    const result = await this.#transitionService.transition({
      orgId: record.orgId,
      factoryProjectId: record.factoryProjectId,
      workItemId: item.id,
      board: board.id,
      stage: route.phase,
      expectedRevision: item.revision,
      actor: { type: 'system', id: `intake-route:${route.routeId}` },
      ingress: { type: 'rule', identity },
      cause: 'event_route',
      causalChain,
      eventRoute: { routeId: route.routeId },
    });
    // A refusal is the card's answer (recorded on it); only a lost revision race is worth a retry.
    if (result.status === 'rejected' && result.code === 'stale') throw new Error(`${result.code}: ${result.reason}`);
  }

  /**
   * Whether a later status event was queued for the same card: the source's last word wins, so a
   * close still queued when the issue is reopened moves nothing. Of events queued in the same
   * millisecond, the one with the greatest id is the last; one already settled had its turn.
   */
  async #statusEventOvertaken(record: FactoryDeferredDecisionRecord): Promise<boolean> {
    if (!record.workItemId || !isStatusEventDecision(record.decision)) return false;
    const decisions = await this.#storage.listDeferredDecisions(record.orgId, record.factoryProjectId, {
      workItemId: record.workItemId,
    });
    return decisions.some(
      other =>
        other.id !== record.id &&
        isStatusEventDecision(other.decision) &&
        (other.createdAt.getTime() > record.createdAt.getTime() ||
          (other.createdAt.getTime() === record.createdAt.getTime() &&
            other.completedAt === null &&
            other.id > record.id)),
    );
  }

  async #requireItem(record: FactoryDeferredDecisionRecord) {
    if (!record.workItemId) throw new Error('Factory decision is not linked to a work item.');
    const item = await this.#storage.get({ orgId: record.orgId, id: record.workItemId });
    if (!item) throw new Error('Factory work item not found.');
    return item;
  }

  async #findBinding(
    record: FactoryDeferredDecisionRecord,
    role?: string,
  ): Promise<FactoryRunBindingRecord | undefined> {
    if (!record.workItemId) throw new Error('Factory decision is not linked to a work item.');
    const bindings = await this.#storage.listRunBindings(record.orgId, record.factoryProjectId, record.workItemId);
    const active = bindings.filter(
      candidate => candidate.status === 'active' && (role === undefined || candidate.role === role),
    );
    // Without a role, the builder's session answers for the card: it owns the work.
    let builder: string | undefined;
    if (role === undefined && active.length > 1) {
      const item = await this.#storage.get({ orgId: record.orgId, id: record.workItemId });
      builder = item ? cardBoardFlow(await this.#boards.load(record), item).buildRole : undefined;
    }
    return active.sort((left, right) => {
      if (builder !== undefined && left.role === builder && right.role !== builder) return -1;
      if (builder !== undefined && right.role === builder && left.role !== builder) return 1;
      return right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id);
    })[0];
  }

  async #requireBinding(record: FactoryDeferredDecisionRecord, role?: string): Promise<FactoryRunBindingRecord> {
    const binding = await this.#findBinding(record, role);
    if (!binding) {
      throw new FactoryDispatchError(
        'session_unavailable',
        role ? `No active Factory binding for role ${role}.` : 'No active Factory binding.',
      );
    }
    return binding;
  }

  /**
   * Points the card's live session at new activity on its source. The message
   * is written here from the decision's pointers, never from provider text.
   * Activity while the session is busy waits as one pending notification per
   * card and kind of activity, counting how many arrived; an idle session is
   * woken unless the decision asks to only persist. A card nobody is working
   * has nobody to tell, so it is dropped.
   */
  async #signalActivity(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'signalActivity' }>,
  ): Promise<void> {
    if (!record.workItemId) return;
    const binding = await this.#findBinding(record);
    if (!binding) return;
    const item = await this.#storage.get({ orgId: record.orgId, id: record.workItemId });
    const startedBy = item?.sessions[binding.role]?.startedBy;
    if (!startedBy) throw new Error(`Factory binding ${binding.id} has no authenticated session owner.`);
    const onSeam = await this.#onRuntimeSeam(binding); // fork(claude-agent)
    if (!onSeam) await this.#primeCredentials?.({ orgId: record.orgId, userId: startedBy });
    const session = onSeam
      ? undefined
      : await this.#requireSession(binding, { userId: startedBy, orgId: record.orgId });
    const author = decision.author
      ? `@${decision.author}${decision.authorTrusted ? '' : ' (untrusted author)'}`
      : decision.authorTrusted
        ? undefined
        : 'an untrusted author';
    const message =
      decision.event === 'work_item.commented'
        ? `New comment${author ? ` by ${author}` : ''} on ${decision.reference}: ${decision.url}`
        : `${decision.reference} was edited${author ? ` by ${author}` : ''}: ${decision.url}`;
    // An untrusted author never starts a run, nor does a source that can't tell Factory's own
    // comments apart. Core never wakes a thread for a low-priority notification on any path;
    // a medium one can still wake it through a summary if the busy run ends mid-delivery.
    const wakes = decision.authorTrusted && decision.idleBehavior !== 'persist';
    // fork(claude-agent): only a trusted author's activity wakes the session; a busy one hears it next turn.
    if (!session) {
      const wake = wakes && !this.#runtimeSessions!.isRunning(binding.sessionId);
      await this.#messageOnSeam(binding, startedBy, record.orgId, { text: message, source: 'source-activity', wake });
      return;
    }
    await awaitNotification(() =>
      session.sendNotificationSignal(
        {
          source: 'factory',
          kind: 'source-activity',
          summary: message,
          priority: wakes ? 'medium' : 'low',
          sourceId: record.id,
          dedupeKey: record.idempotencyKey,
          coalesceKey: `${record.workItemId}:${decision.event}`,
        },
        {
          ifActive: { behavior: 'persist' },
          ifIdle: { behavior: wakes ? 'wake' : 'persist' },
          requestContext: factoryRequestContext({ session, binding, userId: startedBy, orgId: record.orgId }),
        },
      ),
    );
  }

  async #messageBinding(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'sendMessage' }>,
  ): Promise<FactoryRunBindingRecord | undefined> {
    if (decision.prepareBinding && decision.role !== undefined) {
      return this.#requireOrPrepareBinding(record, decision.role);
    }
    return this.#findBinding(record, decision.role);
  }

  /**
   * A role is superseded when its binding was revoked by a later role taking
   * the same session (`prepareRunBinding` revokes every other active binding on
   * that session). Only a hand-on — the running agent or a person moving the
   * card — produces that shape, so the role's job is done: its decision is not
   * owed a retry, and whatever ends the shared turn afterwards belongs to the
   * successor's decision. A revoke with no successor (terminal cleanup, an
   * operator pulling the seat) is not supersession and still fails as before.
   * Only a hand-on that happened after this decision was queued counts: a
   * fresh decision for the role (the card came back to it) must still dispatch
   * even though an older revoked binding for that role is on record.
   */
  async #decisionOvertaken(record: FactoryDeferredDecisionRecord, role: string): Promise<boolean> {
    if (!record.workItemId) return false;
    const [item, siblings] = await Promise.all([
      this.#storage.get({ orgId: record.orgId, id: record.workItemId }),
      this.#storage.listDecisionsForEvaluations(record.orgId, record.factoryProjectId, [record.evaluationId]),
    ]);
    return decisionOvertaken({ boards: await this.#boards.load(record), item, record, role, siblings });
  }

  async #roleSuperseded(record: FactoryDeferredDecisionRecord, role: string): Promise<boolean> {
    if (!record.workItemId) return false;
    const bindings = await this.#storage.listRunBindings(record.orgId, record.factoryProjectId, record.workItemId);
    const own = bindings.filter(candidate => candidate.role === role);
    // An active seat for this role still runs — a terminal card can legitimately
    // hold one (e.g. a close-out skill dispatched on `done`).
    if (own.some(candidate => candidate.status === 'active')) return false;
    // With no active seat left, a card that has already reached a terminal stage
    // can never mint one for this role again, and its bindings are being revoked
    // out from under the run by terminal-stage cleanup. Treat the decision as
    // superseded so it stops retrying to MAX_ATTEMPTS as `session_unavailable`.
    const item = await this.#storage.get({ orgId: record.orgId, id: record.workItemId }).catch(() => null);
    if (item && workItemPhaseSemantics(await this.#boards.load(record), item)?.kind === 'terminal') return true;
    return own.some(
      revoked =>
        revoked.revokedAt !== null &&
        revoked.revokedAt.getTime() >= record.createdAt.getTime() &&
        bindings.some(
          successor =>
            successor.role !== role &&
            successor.status === 'active' &&
            successor.resourceId === revoked.resourceId &&
            successor.sessionId === revoked.sessionId &&
            successor.threadId === revoked.threadId &&
            successor.createdAt.getTime() >= revoked.revokedAt!.getTime(),
        ),
    );
  }

  async #requireOrPrepareBinding(
    record: FactoryDeferredDecisionRecord,
    role: string,
    expectedBindingId?: string,
  ): Promise<FactoryRunBindingRecord> {
    const binding = await this.#findBinding(record, role);
    if (expectedBindingId && binding?.id !== expectedBindingId) {
      return this.#sameRoleReplacement(record, role, expectedBindingId);
    }
    if (binding) {
      if (await this.#mastraCode.runs(binding.sessionId)) return binding;
    }
    if (!this.#prepareBinding) {
      throw new FactoryDispatchError(
        'session_unavailable',
        binding ? 'Bound Factory session not found.' : `No active Factory binding for role ${role}.`,
      );
    }
    const item = await this.#requireItem(record);
    try {
      await this.#prepareBinding({ record, item, role, expectedBindingId });
    } catch (error) {
      if (error instanceof FactoryRunBindingSupersededError) {
        if (expectedBindingId) return this.#sameRoleReplacement(record, role, expectedBindingId);
        throw new FactoryDecisionSuperseded();
      }
      throw error;
    }
    return this.#requireBinding(record, role);
  }

  async #sameRoleReplacement(
    record: FactoryDeferredDecisionRecord,
    role: string,
    expectedBindingId: string,
  ): Promise<FactoryRunBindingRecord> {
    const replacement = await this.#findBinding(record, role);
    if (
      !replacement ||
      replacement.id === expectedBindingId ||
      (await this.#roleSuperseded(record, role)) ||
      (await this.#decisionOvertaken(record, role))
    ) {
      throw new FactoryDecisionSuperseded();
    }
    if (!(await this.#mastraCode.runs(replacement.sessionId))) {
      throw new FactoryDispatchError('session_unavailable', 'Bound Factory session not found.');
    }
    return replacement;
  }

  async #findSession(
    binding: FactoryRunBindingRecord,
    owner: SessionOwner,
  ): Promise<BoundDispatcherSession | undefined> {
    const session = await this.#controller.getSession(binding.sessionId);
    if (!session) return undefined;
    await this.#switchThread(session, binding, owner);
    return session;
  }

  /**
   * The tool whose pauses the run answers itself: the exit tool of the card's phase, where the
   * board approves it without a person for this card. Any other pause waits for a person.
   */
  async #autoApprovedExitTool({
    orgId,
    factoryProjectId,
    workItemId,
  }: {
    orgId: string;
    factoryProjectId: string;
    workItemId: string | null;
  }): Promise<string | undefined> {
    const item = workItemId ? await this.#storage.get({ orgId, id: workItemId }) : null;
    return item ? autoApprovedExitTool(await this.#boards.load({ orgId, factoryProjectId }), item) : undefined;
  }

  /** Whether a run this dispatcher watches is about to approve `toolCallId` itself, so no person needs asking. */
  autoApproves(toolCallId: string): boolean {
    return this.#autoApproving.has(toolCallId);
  }

  /**
   * fork(claude-agent): slice 5d. How a Mastra Code run approves the call it paused on, on the board's
   * behalf: through the call's interaction broker record, which the session's controller holds and
   * resumes as the run's owner (`requestContext`), recorded as answered by the Factory. The record is
   * kept a moment after the controller reports the pause, so it is waited for. A call no yes answers
   * (a question, a tool that resumes on input of its own) is left for a person, as is one the broker
   * never records; one answered meanwhile by someone else is theirs, and the run carries on from it.
   */
  #approver(sessionId: string, requestContext: RequestContext, label: string): ApprovePausedCall | undefined {
    const interactions = this.#interactions;
    if (!interactions) return undefined;
    return async ({ toolCallId, toolName }) => {
      // The board no longer answers it: its followers hear of it as they would have (review fix).
      const leaveForPerson = (record?: InteractionRecord) => {
        this.#autoApproving.delete(toolCallId);
        interactions.announce?.({ sessionId, toolCallId, toolName, ...(record ? { record } : {}) });
      };
      const record = await interactions.whenWaitingOn(sessionId, toolCallId, HELD_RECORD_WAIT_MS);
      const response = record ? approvalOf(record.request) : undefined;
      if (!record || !response) {
        if (!record) {
          console.warn(
            `[factory] ${label}: the paused call ${toolCallId} of session ${sessionId} was never recorded; it waits for a person.`,
          );
        }
        leaveForPerson(record);
        return undefined;
      }
      return async () => {
        try {
          await interactions.broker.resolve(record.id, response, { resolvedBy: 'factory', context: requestContext });
        } catch (error) {
          leaveForPerson(record);
          const why =
            error instanceof InteractionAnswerRefusedError
              ? (error.detail ?? error.reason)
              : error instanceof Error
                ? error.message
                : String(error);
          throw new FactoryDispatchError(
            'run_failed',
            `${label} could not carry on from the ${record.request.kind === 'plan_approval' ? 'plan' : 'call'} it approved: ${why}`,
            { cause: error },
          );
        }
      };
    };
  }

  /**
   * Whether a run is in flight on `binding`: live here, or live on another dispatcher. An open-run
   * entry with nothing live behind it is an orphan of a dead process and does not count.
   */
  async #hasRunInFlight(session: BoundDispatcherSession, binding: FactoryRunBindingRecord): Promise<boolean> {
    const open = (await listSessionOpenRuns(session)).filter(entry => entry.bindingId === binding.id);
    if (open.length === 0) return false;
    if (open.some(entry => isOpenRunLiveElsewhere(entry, this.#ownerId))) return true;
    return this.#mastraCode.isThreadRunning(binding.threadId);
  }

  /** Waits for the run in flight on `binding` to end, so a kickoff never overlaps it. */
  async #waitForOpenRun(session: BoundDispatcherSession, binding: FactoryRunBindingRecord, label: string) {
    const runStillActive = () => this.#mastraCode.isThreadRunning(binding.threadId);
    // Only a *live* run on this binding can be duplicated by a second
    // kickoff, so that is the only thing worth waiting on. The open-run
    // ledger is shared by every replica, but the run registry is local, so
    // an entry with nothing live here is one of two things:
    //  - live on another replica (fresh heartbeat from another owner):
    //    hand the decision back to retry, since that owner will clear the
    //    entry and only it can observe the run end;
    //  - an orphan (stale or missing heartbeat): the run died with its
    //    process and no `agent_end` will ever clear it. Waiting would
    //    wedge the binding for good; the next observed run end sweeps it.
    while (true) {
      const openRun = watchRun(session, {
        timeoutMs: this.#skillCompletionObservationTimeoutMs,
        label,
        runStillActive,
      });
      try {
        const open = (await listSessionOpenRuns(session)).filter(entry => entry.bindingId === binding.id);
        if (open.length === 0) break;
        if (open.some(entry => isOpenRunLiveElsewhere(entry, this.#ownerId))) {
          throw new FactoryDispatchError(
            'session_unavailable',
            `Factory binding ${binding.id} has a run in flight on another dispatcher.`,
          );
        }
        if (!runStillActive()) break;
        if (!(await openRun.wait())) break;
      } finally {
        openRun.close();
      }
      await waitForSessionRunAudit(session);
    }
  }

  async #requireSession(binding: FactoryRunBindingRecord, owner: SessionOwner): Promise<BoundDispatcherSession> {
    const session = await this.#findSession(binding, owner);
    if (!session) throw new FactoryDispatchError('session_unavailable', 'Bound Factory session not found.');
    return session;
  }

  // Switching subscribes to the thread, which resolves memory and model
  // credentials, so it always runs as the session owner.
  async #switchThread(
    session: BoundDispatcherSession,
    binding: FactoryRunBindingRecord,
    owner: SessionOwner,
  ): Promise<void> {
    if (session.thread.requireId() === binding.threadId) return;
    const requestContext = factoryRequestContext({ session, binding, userId: owner.userId, orgId: owner.orgId });
    await session.thread.switch({ threadId: binding.threadId, requestContext });
  }

  async #withBindingSkillRun(bindingId: string, effect: () => Promise<void>): Promise<void> {
    const previous = this.#bindingSkillRuns.get(bindingId);
    const run = (previous ?? Promise.resolve()).catch(() => {}).then(effect);
    this.#bindingSkillRuns.set(bindingId, run);
    try {
      await run;
    } finally {
      if (this.#bindingSkillRuns.get(bindingId) === run) this.#bindingSkillRuns.delete(bindingId);
    }
  }

  async #withLease(
    renew: (leaseExpiresAt: Date) => Promise<unknown | null>,
    effect: () => Promise<void>,
  ): Promise<void> {
    let renewalFailure: unknown;
    let renewal = Promise.resolve();
    const timer = setInterval(
      () => {
        renewal = renewal.then(async () => {
          try {
            const renewed = await renew(new Date(Date.now() + LEASE_MS));
            if (!renewed) renewalFailure = new Error('Factory dispatch lease was lost during execution.');
          } catch (error) {
            renewalFailure = error;
          }
        });
      },
      Math.floor(LEASE_MS / 3),
    );
    timer.unref?.();
    try {
      await effect();
      await renewal;
      if (renewalFailure) throw renewalFailure;
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  /** Keep this process's claim on an open run fresh for as long as it is watching the run. */
  async #withOpenRunHeartbeat<T>(
    session: BoundDispatcherSession,
    kickoffId: string,
    effect: () => Promise<T>,
  ): Promise<T> {
    if (!this.#audit) return effect();
    const timer = setInterval(
      () => void heartbeatSessionOpenRun(session, kickoffId),
      Math.floor(FACTORY_OPEN_RUN_STALE_MS / 3),
    );
    timer.unref?.();
    try {
      return await effect();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Settle a watched run; when it fails terminally, tell the item's followers.
   * A retryable failure says nothing, since the retry reports. How a run that
   * ran ends (done, blocked, an error) is reported by the session's own
   * listener; this covers failures no run end shows. The reporter skips
   * recipients that already have a final report from this run, and never
   * throws, so reporting can't change the decision's outcome.
   */
  async #reportingRunEnd(
    {
      binding,
      startedBy,
      since,
      attempts,
      superseded,
    }: {
      binding: FactoryRunBindingRecord;
      startedBy: string;
      since: Date;
      attempts: number;
      superseded?: () => Promise<boolean>;
    },
    settle: () => Promise<void>,
  ): Promise<void> {
    try {
      await settle();
    } catch (error) {
      const reportRunEnd = this.#reportRunEnd;
      if (
        reportRunEnd &&
        !(error instanceof RunEndedInError) &&
        !(error instanceof FactoryDecisionSuperseded) &&
        !(await superseded?.())
      ) {
        const failureCode = factoryDispatchFailureCode(error);
        if (isTerminalFailure(attempts, failureCode)) {
          void reportRunEnd({
            orgId: binding.orgId,
            factoryProjectId: binding.factoryProjectId,
            workItemId: binding.workItemId,
            role: binding.role,
            sender: { sessionId: binding.sessionId, threadId: binding.threadId, userId: startedBy },
            since,
            outcome: { status: 'failed', failureCode, reason: sanitizeDispatchError(error) },
          }).catch(reportError => {
            console.warn(`[factory] run-end report failed for binding ${binding.id}:`, reportError);
          });
        }
      }
      throw error;
    }
  }

  async #recordRunStart(
    session: BoundDispatcherSession,
    binding: FactoryRunBindingRecord,
    kickoffId: string,
    approvedBy: string | undefined,
    observedEnd: ReturnType<typeof watchRun>['endReason'],
    workItemName: string | undefined,
  ): Promise<void> {
    if (!this.#audit) return;
    const humanApproved = isHumanActorId(approvedBy);
    await recordSessionRunStart(session, {
      audit: this.#audit,
      actorType: humanApproved ? 'human' : 'system',
      observedEnd,
      run: {
        kickoffId,
        ownerId: this.#ownerId,
        heartbeatAt: Date.now(),
        bindingId: binding.id,
        role: binding.role,
        startedBy: humanApproved ? approvedBy : 'factory-rule-dispatcher',
        orgId: binding.orgId,
        factoryProjectId: binding.factoryProjectId,
        workItemId: binding.workItemId,
        workItemName,
        sessionId: binding.sessionId,
        threadId: binding.threadId,
        branch: binding.branch,
      },
    });
  }

  // ── fork(claude-agent): runs on another agent runtime ──────────────────────────────────────
  //
  // A session on Claude Agent is driven through `FactoryRuntimeSessions`, not the agent controller.
  // The board semantics stay the dispatcher's: the same supersession and staleness checks, the
  // same run-ends-with-the-card-moved rule, the same failure codes. The controller session's thread
  // ids are not there: the run's id stands in for the kickoff's message id. Phase goals and the
  // open-run ledger are kept in thread state (`runtimeThreadState`), as `runtime-run-lifecycle` says.

  /** After a turn of a card's run ended on its own (see `afterRunTurn`); a failure never fails the run. */
  async #runTurnEnded(binding: FactoryRunBindingRecord): Promise<void> {
    try {
      await this.#afterRunTurn?.(binding);
    } catch (error) {
      console.warn(`[factory] after a turn on ${binding.sessionId}:`, sanitizeDispatchError(error));
    }
  }

  /** Whether the bound session runs on another runtime. */
  async #onRuntimeSeam(binding: FactoryRunBindingRecord): Promise<boolean> {
    if (!this.#runtimeSessions) return false;
    try {
      return await this.#runtimeSessions.runs(binding.sessionId);
    } catch (error) {
      // Guessing would send a Claude Agent session's run to Mastra Code: hand the decision back.
      throw new FactoryDispatchError(
        'session_unavailable',
        `The runtime of session ${binding.sessionId} could not be read: ${sanitizeDispatchError(error)}`,
        { cause: error },
      );
    }
  }

  /** The request a seam run acts with: the session owner, as for any Factory-started run. */
  #seamRequestContext(userId: string, orgId: string): RequestContext {
    const requestContext = new RequestContext();
    requestContext.set('user', { workosId: userId, organizationId: orgId });
    return requestContext;
  }

  async #messageOnSeam(
    binding: FactoryRunBindingRecord,
    startedBy: string,
    orgId: string,
    message: Parameters<FactoryRuntimeSessions['message']>[1],
    seam: Pick<FactoryRuntimeSessions, 'message'> = this.#runtimeSessions!,
  ): Promise<void> {
    try {
      await seam.message(binding.sessionId, message, this.#seamRequestContext(startedBy, orgId));
    } catch (error) {
      // Mastra Code's adapter classifies its own failures: a session or thread-switch failure
      // (memory/model credentials) propagates raw, as it did before the seam carried the message.
      if (error instanceof FactoryDispatchError || seam === this.#mastraCode) throw error;
      throw new FactoryDispatchError(
        'notification_delivery_failed',
        `Factory message delivery failed: ${sanitizeDispatchError(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * `invokeSkill` through the seam. A session on Claude Agent has its goal judged here, between turns; one
   * on Mastra Code (`ownsGoal`) keeps its objective loop, which re-kicks inside one run and judges it, so
   * the goal is held and reminded in the session as before and the run is watched to its one end.
   */
  async #invokeSkillOnSeam(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'invokeSkill' }>,
    binding: FactoryRunBindingRecord,
    seam: Pick<FactoryRuntimeSessions, 'hasRun' | 'kickoff' | 'ownsGoal'>,
  ): Promise<void> {
    const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    const startedBy = item?.sessions[binding.role]?.startedBy;
    if (!startedBy) throw new Error(`Factory binding ${binding.id} has no authenticated session owner.`);
    const deliveryId = record.deliveryGeneration === 0 ? record.id : `${record.id}:retry:${record.deliveryGeneration}`;
    const kickoffStale = async () =>
      (await this.#roleSuperseded(record, decision.role)) ||
      (await this.#findBinding(record, decision.role))?.id !== binding.id ||
      (await this.#decisionOvertaken(record, decision.role));
    const requestContext = this.#seamRequestContext(startedBy, record.orgId);
    const label = 'Factory skill run';
    // Mastra Code: the controller's session, whose run registry, open-run ledger and goal this run lives in.
    let mastra: { session: BoundDispatcherSession; requestContext: RequestContext } | undefined;
    if (seam.ownsGoal) {
      await this.#primeCredentials?.({ orgId: record.orgId, userId: startedBy });
      const session = await this.#requireSession(binding, { userId: startedBy, orgId: record.orgId });
      mastra = {
        session,
        requestContext: factoryRequestContext({ session, binding, userId: startedBy, orgId: record.orgId }),
      };
    }
    const replayLanded = async () => {
      if (!mastra) return;
      if (decision.goal) {
        await this.#startPhaseGoal(record, decision.goal, mastra.session, binding, mastra.requestContext);
      }
      return this.#replayLanded(record, decision, mastra.session, () =>
        this.#mastraCode.isThreadRunning(binding.threadId),
      );
    };
    if (mastra) {
      // The run in flight on the thread, live here or on another dispatcher, is waited for (or handed back).
      await this.#waitForOpenRun(mastra.session, binding, label);
    } else {
      // A kickoff that already landed is not sent again; a review waits for that run before it says it finished.
      if (await seam.hasRun(binding.sessionId, deliveryId)) {
        if (await this.#isReviewRun(record, decision)) {
          await this.#seamIdle(binding, label);
          this.#reviewReplayed.add(record);
        }
        return;
      }
      await this.#clearSeamSession(binding, requestContext, label, decision.cancelInFlight === true);
    }
    if (await this.#roleSuperseded(record, decision.role)) throw new FactoryDecisionSuperseded();
    const activeBinding = await this.#requireBinding(record, decision.role);
    if (activeBinding.id !== binding.id) {
      throw new FactoryDispatchError(
        'session_unavailable',
        `Factory binding ${binding.id} changed while waiting for its open run to end.`,
      );
    }
    let current: Card | null | undefined;
    if (mastra) {
      if (await seam.hasRun(binding.sessionId, deliveryId)) return replayLanded();
      if (await kickoffStale()) throw new FactoryDecisionSuperseded();
      // Re-read: the description may have been edited while the open run drained.
      current = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
      // The read is async storage I/O; the card can move, and the kickoff land, while it runs.
      if (await seam.hasRun(binding.sessionId, deliveryId)) return replayLanded();
    }
    if (await kickoffStale()) throw new FactoryDecisionSuperseded();
    await this.#reviewQueuedOnce(record, decision);
    // Held before the working-phase check reads the card's revision: holding it stamps the card.
    const seamGoal = !mastra && decision.goal ? await this.#holdSeamGoal(record, decision.goal, binding) : undefined;
    const sessionGoal =
      mastra && decision.goal ? await this.#setPhaseGoal(record, decision.goal, mastra.session, binding) : undefined;
    // Re-read: the description may have been edited while the open run drained.
    if (!mastra) {
      current = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    }
    const since = new Date();
    const workingPhase = await this.#workingPhaseCheck(record, decision, kickoffStale);
    if (seamGoal && !workingPhase) {
      // Factory judges a goal by the card leaving the phase the run works; this run works none.
      console.warn(
        `[factory] ${decision.skillName ?? 'prompt'} run on ${binding.sessionId} does not work its card's phase: its goal is not pursued.`,
      );
    }
    const autoApprovedTool = await this.#autoApprovedExitTool(record);
    await this.#runOnSeam({
      seam,
      ...(mastra ? { session: mastra.session } : {}),
      binding,
      startedBy,
      orgId: record.orgId,
      attempts: record.attempts,
      label,
      kickoff: {
        runId: deliveryId,
        ...(decision.skillName !== undefined
          ? {
              skill: {
                name: decision.skillName,
                ...(decision.arguments !== undefined ? { arguments: decision.arguments } : {}),
                ...(decision.resume ? { resume: true } : {}),
              },
            }
          : { prompt: decision.prompt }),
        description: current?.description ?? null,
        ...(decision.precedingMessage ? { preface: decision.precedingMessage } : {}),
        ...(mastra
          ? {
              thread: { id: binding.threadId, resourceId: binding.resourceId },
              ...(decision.cancelInFlight ? { cancelInFlight: true } : {}),
              ...(autoApprovedTool ? { autoApprovedTool } : {}),
              prefaceKeys: {
                sourceId: `${record.id}:stage-transition`,
                dedupeKey: `${record.idempotencyKey}:stage-transition`,
              },
              stillWanted: async () => !(await kickoffStale()),
              superseded: () => this.#roleSuperseded(record, decision.role),
              ...(sessionGoal
                ? {
                    delivered: () =>
                      this.#remindPhaseGoal(record, sessionGoal, mastra.session, binding, mastra.requestContext),
                  }
                : {}),
            }
          : {}),
      },
      ...(mastra ? {} : { autoApprovedTool }),
      superseded: () => this.#roleSuperseded(record, decision.role),
      ...(workingPhase ? { workingPhase } : {}),
      ...(seamGoal && workingPhase ? { goal: seamGoal } : {}),
      approvedBy: record.approvedBy ?? undefined,
      workItemName: mastra ? item?.title : current?.title,
      onStarted: async () => {
        this.#reviewWatched.add(record);
        await this.#reviewStatus(record, decision, { phase: 'reviewing', startedAt: since });
      },
      onSuperseded: async () => {
        this.#reviewWatched.delete(record);
        await this.#reviewStatus(record, decision, { phase: 'cancelled', endedAt: new Date() });
      },
    });
  }

  /**
   * Make way for a kickoff: never overlap a run in flight (a person's turn, or the previous phase's).
   *
   * A board run parked on a person (its question, its plan to approve) is dropped first, with its
   * pending interaction: Claude answers turns in order, so a kickoff queued behind it would wait on
   * that person, holding this run slot and the binding, however long they take. The interaction
   * belongs to the work the card moved on from, and the Mastra Code run that asked it had already
   * ended (suspended), so nothing is lost that a Mastra Code session would have kept running. A
   * person's own turn, parked or working, is waited for instead (bounded, then the decision goes back
   * for a retry): the board never aborts a person's work unless the rule says `cancelInFlight`.
   */
  async #clearSeamSession(
    binding: FactoryRunBindingRecord,
    requestContext: RequestContext,
    label: string,
    cancel: boolean,
  ): Promise<void> {
    const seam = this.#runtimeSessions!;
    if (seam.isRunning(binding.sessionId) && (cancel || (await seam.parkedBoardRun(binding.sessionId)))) {
      await seam.abort(binding.sessionId, requestContext);
    }
    await this.#seamIdle(binding, label);
  }

  /**
   * Wait for the session's run in flight to end, as long as a run may take, then give the decision back.
   * A run the open-run ledger shows live on another dispatcher can't be seen ending from here: the
   * decision goes back for a retry at once, as for Mastra Code. An entry nothing renews any more is an
   * orphan of a dead process and is not waited for.
   */
  async #seamIdle(binding: FactoryRunBindingRecord, label: string): Promise<void> {
    const ledger = this.#seamLedger?.(binding.threadId);
    if (ledger) {
      try {
        const open = (await listSessionOpenRuns(ledger.handle)).filter(entry => entry.bindingId === binding.id);
        if (open.some(entry => isOpenRunLiveElsewhere(entry, this.#ownerId))) {
          throw new FactoryDispatchError(
            'session_unavailable',
            `Factory binding ${binding.id} has a run in flight on another dispatcher.`,
          );
        }
      } finally {
        ledger.release();
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), this.#skillCompletionObservationTimeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.#runtimeSessions!.idle(binding.sessionId), timedOut]);
      if (outcome === 'timeout') {
        throw new FactoryDispatchError(
          'session_unavailable',
          `${label} could not start: session ${binding.sessionId} still has a run in flight.`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Holds the goal a phase's run pursues on its session's thread, as `#setPhaseGoal` does for Mastra
   * Code (the same record, and the same stamp on the card, so leaving the phase ends it). Keyed on the
   * decision: a retry finds the goal already held, and its count with it.
   */
  async #holdSeamGoal(
    record: FactoryDeferredDecisionRecord,
    goal: { objective: string; maxRuns?: number },
    binding: FactoryRunBindingRecord,
  ): Promise<RuntimeGoal | undefined> {
    const store = await this.#runtimeThreadState?.();
    if (!store) {
      // As before goals came to this runtime: the phase still runs, once.
      console.warn(
        `[factory] run on ${binding.sessionId}: Factory's storage holds no thread state, so its phase goal is not pursued; running once.`,
      );
      return undefined;
    }
    // The phase this run is for, read before the goal exists (the kickoff was checked against it).
    const item = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    const phaseKey = item?.stages.length === 1 ? item.stages[0] : undefined;
    const held = runtimeGoal(record.id, binding.threadId, goal);
    await holdRuntimeGoal(store, held);
    if (!item || !phaseKey) return held;
    const stamp = { phaseKey, goalId: record.id, threadId: binding.threadId, sessionId: binding.sessionId };
    if (phaseGoalOf(item.metadata)?.goalId !== record.id) {
      await this.#storage.update({
        orgId: record.orgId,
        id: item.id,
        userId: 'factory',
        patch: { metadata: { [PHASE_GOAL_METADATA_KEY]: stamp } },
      });
    }
    // A move that committed before the stamp landed found no goal to end: end it here instead.
    const after = await this.#storage.get({ orgId: record.orgId, id: item.id });
    if (after?.stages.length !== 1 || after.stages[0] !== phaseKey) {
      await endPhaseGoal(stamp, { agentFor: async () => undefined, store: async () => runtimeGoalStore(store) });
      throw new FactoryDecisionSuperseded();
    }
    return held;
  }

  /**
   * For a run that works the card's phase (it has a goal or an exit tool), read before it starts:
   * `verify`, the check after a clean end that the run moved the card, as the Mastra Code path makes;
   * and `verdict`, Factory's judgement of the phase's goal after each of its turns. `undefined` for
   * other runs.
   */
  async #workingPhaseCheck(
    record: FactoryDeferredDecisionRecord,
    decision: Extract<FactoryCommitDecision, { type: 'invokeSkill' }>,
    kickoffStale: () => Promise<boolean>,
  ): Promise<SeamWorkingPhase | undefined> {
    const runItem = record.workItemId ? await this.#storage.get({ orgId: record.orgId, id: record.workItemId }) : null;
    if (!runItem) return undefined;
    const boards = await this.#boards.load(record);
    const stage = runItem.stages.length === 1 ? runItem.stages[0] : undefined;
    const phase = stage ? boards.get(boardForWorkItem(runItem))?.phases[stage] : undefined;
    const working =
      phase?.kind === 'working' &&
      (phase.runner.goal || phase.exitTool) &&
      phase.runner.context === decision.role &&
      phase.runner.skill === decision.skillName;
    if (!working) return undefined;
    const workingRevision = runItem.revision;
    const existingLinkedReviewIds = new Set(
      (await this.#storage.listLinked({ item: runItem, limit: 100 })).map(card => card.id),
    );
    const existingPullRequests = new Set(pullRequestSourcesOf(runItem));
    const read = () => this.#storage.get({ orgId: record.orgId, id: record.workItemId! });
    // The run opened its change request: attached to this card (its own pull request), or left to
    // review on that pull request's own card (boards that file it separately).
    const ownCardHandOff = async (after: Card) =>
      pullRequestSourcesOf(after).some(source => !existingPullRequests.has(source)) ||
      (await this.#storage.listLinked({ item: after, limit: 100 })).some(card => {
        if (
          card.parentWorkItemId !== after.id ||
          existingLinkedReviewIds.has(card.id) ||
          card.externalSource?.integrationId !== 'github' ||
          card.externalSource.type !== 'pull-request' ||
          card.stages.length !== 1
        )
          return false;
        const review = boards.get(boardForWorkItem(card))?.phases[card.stages[0]!];
        return review?.kind === 'working' && review.runner.context === 'review';
      });
    return {
      verify: async () => {
        const after = await read();
        if (after?.revision !== workingRevision || (await kickoffStale())) return;
        if (await ownCardHandOff(after)) return;
        throw new FactoryDispatchError(
          'run_incomplete',
          'Factory skill run ended before completing the working phase.',
        );
      },
      verdict: async () => {
        const after = await read();
        if (!after || after.stages.length !== 1 || after.stages[0] !== stage) return 'met';
        if (await kickoffStale()) return 'stale';
        return (await ownCardHandOff(after)) ? 'met' : 'unmet';
      },
    };
  }

  /**
   * Start a run through the seam and settle the decision on how it ended. A run with a goal goes on
   * while the goal is unmet and runs remain, each turn judged by Factory (`judgeRuntimeGoal`), the
   * whole of it one run, as Mastra Code's goal loop keeps one run going. The run is on the open-run
   * ledger and in the audit log from its kickoff to its end, as a Mastra Code run is.
   *
   * A run parked on a person ends the decision, as a suspended Mastra Code run does; it is followed in
   * the background once they answer, so its goal goes on and its run record ends.
   */
  async #runOnSeam(run: SeamRun): Promise<void> {
    const { binding, startedBy, label, seam, session } = run;
    const requestContext = this.#seamRequestContext(startedBy, run.orgId);
    let approvals = 0;
    const autoApprovePlan = run.autoApprovedTool === 'submit_plan' ? () => approvals++ < MAX_PLAN_APPROVALS : undefined;
    const send = async (kickoff: Omit<Parameters<FactoryRuntimeSessions['kickoff']>[1], 'autoApprovePlan'>) => {
      try {
        return await seam.kickoff(
          binding.sessionId,
          { ...kickoff, ...(autoApprovePlan ? { autoApprovePlan } : {}) },
          requestContext,
        );
      } catch (error) {
        // Mastra Code's adapter classifies its own failures: they propagate raw, as before the seam carried it.
        if (error instanceof FactoryDispatchError || session) throw error;
        // Nothing reached the runtime, so a retry with a fresh delivery is safe.
        throw new FactoryDispatchError(
          'notification_delivery_failed',
          `${label} did not start: ${sanitizeDispatchError(error)}`,
          {
            cause: error,
          },
        );
      }
    };
    const since = new Date();
    const kickoffId = run.kickoff.runId;
    let started = await send({
      ...run.kickoff,
      ...(run.goal ? { goal: { objective: run.goal.objective, maxRuns: run.goal.maxRuns } } : {}),
    });
    // A Mastra Code run is on its session's open-run ledger, and its end recorded by the session's own listener.
    let record: RuntimeRunLedger | undefined;
    if (session) {
      await this.#recordRunStart(
        session,
        binding,
        kickoffId,
        run.approvedBy,
        started.observedEnd ?? (() => undefined),
        run.workItemName,
      );
    } else {
      record = await this.#openSeamRun(run, kickoffId);
    }
    const steps: FactoryRunUsageCounts[] = [];
    // How the run ended, once it has; a parked or overdue run is followed instead.
    let ended: 'complete' | 'aborted' | 'error' | undefined;
    let following: Promise<RuntimeRunEnd> | undefined;
    await run.onStarted?.();
    // Whether the role had handed the card on when its run ended; a move after that keeps the run's verdict.
    let supersededAtEnd: Promise<boolean> | undefined;
    const handedOn = async () => (await supersededAtEnd) ?? (await run.superseded?.()) ?? false;
    try {
      await this.#reportingRunEnd(
        { binding, startedBy, since, attempts: run.attempts, superseded: handedOn },
        async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          // A Mastra Code run's own watch times it (`run_overdue`).
          const overdue = new Promise<never>((_resolve, reject) => {
            if (session) return;
            timer = setTimeout(
              () =>
                reject(
                  new FactoryDispatchError(
                    'run_overdue',
                    `${label} is still in flight after ${Math.round(this.#skillCompletionObservationTimeoutMs / 3_600_000)} hours and needs a person.`,
                  ),
                ),
              this.#skillCompletionObservationTimeoutMs,
            );
            timer.unref?.();
          });
          try {
            while (true) {
              following = started.ended;
              const waiting = started.ended;
              const end = await (session
                ? this.#withOpenRunHeartbeat(session, kickoffId, () => waiting)
                : Promise.race([waiting, overdue]));
              following = undefined;
              steps.push(...runtimeUsageSteps(end.usage));
              supersededAtEnd = end.supersededAtEnd ?? run.superseded?.() ?? Promise.resolve(false);
              if (end.failure) {
                ended = end.reason === 'aborted' ? 'aborted' : 'error';
                throw end.failure;
              }
              if (end.reason === 'error') {
                ended = 'error';
                throw runErrorFailure(label, new Error(end.error ?? 'The run failed.'));
              }
              if (end.reason === 'aborted') {
                ended = 'aborted';
                throw new Error(`${label} was aborted before it finished.`);
              }
              // Parked on a person (a plan to approve, a question), like a suspended Mastra Code run: its
              // turn goes on once they answer, and the card moves then.
              if (end.reason === 'awaiting_interaction') {
                if (!session) following = end.resumed ?? Promise.resolve(end);
                return;
              }
              ended = 'complete';
              if (await supersededAtEnd) return;
              if (session) {
                // A final tool result can persist after the run's end: read this binding's trailing results
                // before deciding the unchanged card means the run did no work. Only a run working its phase.
                if (!run.workingPhase) return;
                await this.#reconcileRunBinding?.(binding);
              }
              await this.#runTurnEnded(binding);
              if (!run.goal || !run.workingPhase) {
                await run.workingPhase?.verify();
                return;
              }
              const step = await this.#seamGoalStep(
                run.goal,
                run.workingPhase,
                binding,
                send,
                kickoffId,
                requestContext,
              );
              if (step.kind === 'done') {
                await run.workingPhase.verify();
                return;
              }
              // Parked on the person, as a run parked on its `ask_user` is: followed once they reply.
              if (step.kind === 'waiting') {
                ended = undefined;
                following = step.resumed;
                return;
              }
              // Another turn took the session first (a person's): its goal goes on after it, unwatched,
              // as a Mastra Code run steered by a person goes on.
              if (step.kind === 'busy') {
                ended = undefined;
                following = Promise.resolve({ reason: 'complete' });
                return;
              }
              started = step.started;
              ended = undefined;
            }
          } finally {
            clearTimeout(timer);
          }
        },
      );
      if (supersededAtEnd && (await supersededAtEnd)) await run.onSuperseded?.();
    } catch (error) {
      // Handed on mid-turn: the turn's verdict is the successor's to record.
      if (!(await handedOn())) throw error;
      await run.onSuperseded?.();
    } finally {
      if (session) {
        // The session's own listener ends the run's record (with its usage) and renews nothing more here.
      } else if (ended) await this.#closeSeamRun(record, binding, kickoffId, ended, steps);
      else if (following) void this.#followSeamRun(run, { record, kickoffId, steps, send }, following);
    }
  }

  /**
   * Follow a seam run nobody watches any more (parked on a person, or overdue) to its end: its goal
   * goes on as it would have while watched, and its run record ends. Its failures are only logged:
   * the decision that started it is settled, as for a resumed Mastra Code run.
   */
  async #followSeamRun(
    run: SeamRun,
    ctx: {
      record: RuntimeRunLedger | undefined;
      kickoffId: string;
      steps: FactoryRunUsageCounts[];
      send: SeamSend;
    },
    pending: Promise<RuntimeRunEnd>,
  ): Promise<void> {
    const { binding } = run;
    let current: Promise<RuntimeRunEnd> | undefined = pending;
    let ended: 'complete' | 'aborted' | 'error' = 'complete';
    try {
      while (current) {
        const end: RuntimeRunEnd = await current;
        current = undefined;
        ctx.steps.push(...runtimeUsageSteps(end.usage));
        if (end.reason === 'awaiting_interaction') {
          // A runtime that can't say how a parked run goes on: nothing will end it, so it ends here.
          if (!end.resumed) {
            ended = 'aborted';
            break;
          }
          current = end.resumed;
          continue;
        }
        if (end.reason !== 'complete') {
          ended = end.reason;
          break;
        }
        const goal = run.goal;
        const workingPhase = run.workingPhase;
        if (await run.superseded?.()) break;
        await this.#runTurnEnded(binding);
        if (!goal || !workingPhase) break;
        // Another turn in flight (a person's, a new phase's kickoff): the goal is judged once it ends.
        await this.#runtimeSessions!.idle(binding.sessionId);
        const taken: { step: SeamGoalStep } = { step: { kind: 'done' } };
        await this.#withBindingSkillRun(binding.id, async () => {
          taken.step = await this.#seamGoalStep(
            goal,
            workingPhase,
            binding,
            ctx.send,
            ctx.kickoffId,
            this.#seamRequestContext(run.startedBy, run.orgId),
          );
        });
        const step = taken.step;
        if (step.kind === 'busy') {
          current = Promise.resolve({ reason: 'complete' });
          continue;
        }
        if (step.kind === 'waiting') {
          current = step.resumed;
          continue;
        }
        if (step.kind === 'done') break;
        current = step.started.ended;
      }
    } catch (error) {
      console.warn(
        `[factory] following run ${ctx.kickoffId} on ${binding.sessionId} failed:`,
        sanitizeDispatchError(error),
      );
      ended = 'error';
    }
    await this.#closeSeamRun(ctx.record, binding, ctx.kickoffId, ended, ctx.steps);
  }

  /**
   * The goal's next step after a turn that ended on its own: `done` (met, spent, no longer this run's),
   * `rekicked`, or `busy` when another turn holds the session (a person's), which a re-kick must never
   * queue behind with a verdict from before it. Judged right before the re-kick is sent.
   *
   * fork(claude-agent): a turn that ended asking the person something in plain text is not re-kicked
   * (a goal-judge reminder would answer it for them): it is parked on that question (`waiting`).
   */
  async #seamGoalStep(
    goal: RuntimeGoal,
    workingPhase: SeamWorkingPhase,
    binding: FactoryRunBindingRecord,
    send: SeamSend,
    kickoffId: string,
    requestContext: RequestContext,
  ): Promise<SeamGoalStep> {
    const seam = this.#runtimeSessions!;
    if (seam.isRunning(binding.sessionId)) return { kind: 'busy' };
    const next = await this.#nextSeamGoalAttempt(goal, workingPhase, binding);
    if (!next) return { kind: 'done' };
    // Judging read storage: a turn that started meanwhile goes first, and the goal is judged after it.
    if (seam.isRunning(binding.sessionId)) return { kind: 'busy' };
    if ('waiting' in next) {
      const parked = await seam.awaitReply!(binding.sessionId, { question: next.waiting }, requestContext);
      if (parked) return { kind: 'waiting', resumed: parked.resumed };
      // Nobody can be asked here after all: the goal goes on as it would have.
      const again = await this.#nextSeamGoalAttempt(goal, workingPhase);
      if (!again || 'waiting' in again) return { kind: 'done' };
      return {
        kind: 'rekicked',
        started: await send({ runId: `${kickoffId}:goal:${again.attempt}`, continuation: again.continuation }),
      };
    }
    return {
      kind: 'rekicked',
      started: await send({ runId: `${kickoffId}:goal:${next.attempt}`, continuation: next.continuation }),
    };
  }

  /** The goal's re-kick after a turn that ended on its own, or none (met, spent, no longer this run's). */
  async #nextSeamGoalAttempt(
    goal: RuntimeGoal,
    workingPhase: SeamWorkingPhase,
    // fork(claude-agent): asked whether the turn ended waiting on a person, when it can be parked on them.
    asking?: FactoryRunBindingRecord,
  ): Promise<{ continuation: string; attempt: number } | { waiting: string } | undefined> {
    const store = await this.#runtimeThreadState?.();
    if (!store) return undefined;
    const seam = this.#runtimeSessions!;
    const waiting =
      asking && seam.askedPerson && seam.awaitReply
        ? () => seam.askedPerson!(asking.sessionId, { objective: goal.objective })
        : undefined;
    // Claude's Factory tool results reach the board before Claude gets them: nothing trails the turn.
    return judgeRuntimeGoal(store, goal, workingPhase.verdict, waiting);
  }

  /**
   * Put a seam run on its thread's open-run ledger and record its start, as `#recordRunStart` does. Its
   * entry is renewed until the run's record ends (`#closeSeamRun`), watched or followed: a parked run is
   * live, and another dispatcher must neither sweep it nor start a second Claude Code beside it.
   */
  async #openSeamRun(run: SeamRun, kickoffId: string): Promise<RuntimeRunLedger | undefined> {
    const ledger = this.#seamLedger?.(run.binding.threadId);
    if (!ledger) return undefined;
    if (!this.#audit) {
      ledger.release();
      return undefined;
    }
    const { binding } = run;
    const humanApproved = isHumanActorId(run.approvedBy);
    const heartbeat = setInterval(
      () => void heartbeatSessionOpenRun(ledger.handle, kickoffId),
      Math.floor(FACTORY_OPEN_RUN_STALE_MS / 3),
    );
    heartbeat.unref?.();
    this.#seamOpenRuns.set(kickoffId, heartbeat);
    await recordSessionRunStart(ledger.handle, {
      audit: this.#audit,
      actorType: humanApproved ? 'human' : 'system',
      // The run's end is recorded by whoever follows it (`#closeSeamRun`).
      observedEnd: () => undefined,
      run: {
        kickoffId,
        ownerId: this.#ownerId,
        heartbeatAt: Date.now(),
        bindingId: binding.id,
        role: binding.role,
        startedBy: humanApproved ? run.approvedBy! : 'factory-rule-dispatcher',
        orgId: binding.orgId,
        factoryProjectId: binding.factoryProjectId,
        workItemId: binding.workItemId,
        ...(run.workItemName ? { workItemName: run.workItemName } : {}),
        sessionId: binding.sessionId,
        threadId: binding.threadId,
        branch: binding.branch,
      },
    });
    return ledger;
  }

  /**
   * End a seam run's record and stop renewing its entry. Entries on the thread's ledger whose run
   * nothing here follows and nothing elsewhere renews died with their process: they end too (as
   * aborted), as Mastra Code's next run end sweeps them.
   */
  async #closeSeamRun(
    ledger: RuntimeRunLedger | undefined,
    binding: FactoryRunBindingRecord,
    kickoffId: string,
    reason: 'complete' | 'aborted' | 'error',
    steps: FactoryRunUsageCounts[],
  ): Promise<void> {
    clearInterval(this.#seamOpenRuns.get(kickoffId));
    this.#seamOpenRuns.delete(kickoffId);
    if (!ledger || !this.#audit) return;
    try {
      await recordSessionRunEnd(ledger.handle, {
        audit: this.#audit,
        reason,
        ending: entry => entry.kickoffId === kickoffId,
        steps,
      });
      await recordSessionRunEnd(ledger.handle, {
        audit: this.#audit,
        reason: 'aborted',
        ending: entry =>
          entry.kickoffId !== kickoffId &&
          !this.#seamOpenRuns.has(entry.kickoffId) &&
          !isOpenRunLiveElsewhere(entry, this.#ownerId),
        steps: [],
      });
    } catch (error) {
      console.warn(`[factory] recording the end of run ${kickoffId} on ${binding.sessionId} failed:`, error);
    } finally {
      ledger.release();
    }
  }

  async #dispatchPendingStart(record: FactoryPendingStartRecord, now: Date): Promise<void> {
    try {
      await this.#withLease(
        async leaseExpiresAt =>
          this.#storage.renewPendingStartLease(leaseIdentity(record, this.#ownerId), leaseExpiresAt),
        async () => {
          if (record.message === null) return;
          const bindings = await this.#storage.listRunBindings(record.orgId, record.factoryProjectId);
          const binding = bindings.find(
            candidate => candidate.id === record.bindingId && candidate.status === 'active',
          );
          if (!binding) {
            throw new FactoryDispatchError(
              'session_unavailable',
              'Prepared Factory binding is unavailable or revoked.',
            );
          }
          // Wake runs build the Factory workspace, which requires the
          // authenticated session owner on the request context.
          const item = await this.#storage.get({ orgId: record.orgId, id: binding.workItemId });
          const startedBy = item?.sessions[binding.role]?.startedBy;
          if (!startedBy) throw new Error(`Factory binding ${binding.id} has no authenticated session owner.`);
          // fork(claude-agent): the same replay guard and wait as a skill kickoff on the seam.
          if (await this.#onRuntimeSeam(binding)) {
            const kickoffId = `factory-kickoff:${record.kickoffKey}:${record.attempts}`;
            const label = 'Factory kickoff run';
            // Any earlier attempt's kickoff counts, as the inbox dedupes Mastra Code's on the kickoff key.
            for (let attempt = 1; attempt <= record.attempts; attempt += 1) {
              if (
                await this.#runtimeSessions!.hasRun(
                  binding.sessionId,
                  `factory-kickoff:${record.kickoffKey}:${attempt}`,
                )
              )
                return;
            }
            await this.#clearSeamSession(binding, this.#seamRequestContext(startedBy, record.orgId), label, false);
            await this.#runOnSeam({
              seam: this.#runtimeSessions!,
              binding,
              startedBy,
              orgId: record.orgId,
              attempts: record.attempts,
              label,
              kickoff: { runId: kickoffId, prompt: record.message },
              autoApprovedTool: await this.#autoApprovedExitTool({ ...record, workItemId: binding.workItemId }),
              approvedBy: startedBy,
              workItemName: item?.title,
            });
            return;
          }
          await this.#primeCredentials?.({ orgId: record.orgId, userId: startedBy });
          const session = await this.#requireSession(binding, { userId: startedBy, orgId: record.orgId });
          const requestContext = factoryRequestContext({
            session,
            binding,
            userId: startedBy,
            orgId: record.orgId,
          });
          // The run's own verdict, not the delivery's: a kickoff delivered
          // into a run that is already terminating is consumed without
          // execution, and completing the pending start on the delivery ack
          // alone strands the card with a success ledger entry.
          const since = new Date();
          const run = watchRun(session, {
            timeoutMs: this.#skillCompletionObservationTimeoutMs,
            autoApprovedTool: await this.#autoApprovedExitTool({ ...record, workItemId: binding.workItemId }),
            autoApproving: this.#autoApproving,
            approve: this.#approver(binding.sessionId, requestContext, 'Factory kickoff run'), // fork(claude-agent)
            label: 'Factory kickoff run',
            runStillActive: () => this.#mastraCode.isThreadRunning(binding.threadId),
          });
          const sendKickoff = (dedupeKey: string) =>
            awaitNotification(
              () =>
                session.sendNotificationSignal(
                  {
                    source: 'factory',
                    kind: 'run-kickoff',
                    summary: record.message!,
                    priority: 'high',
                    payload: { message: record.message },
                    sourceId: record.id,
                    dedupeKey,
                  },
                  { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'wake' }, requestContext },
                ),
              true,
            );
          try {
            let settled = await sendKickoff(`factory-kickoff:${record.kickoffKey}`);
            let deliveryGeneration = 0;
            while (settled?.action === 'deliver') {
              // `deliver` only proves the signal was queued onto a run already
              // in flight. If that run ends without draining its queue the
              // kickoff is dropped silently. Another run can start while the
              // previous one is finishing, so follow every run boundary until
              // the kickoff wakes an idle session. The generation-scoped
              // dedupeKey defeats inbox dedupe and the kickoff key keeps a
              // duplicate run bounded, while a dropped kickoff strands the card.
              if (!(await run.wait())) {
                throw new Error('Factory kickoff is waiting on a run that has not ended.');
              }
              run.arm();
              deliveryGeneration += 1;
              settled = await sendKickoff(
                `factory-kickoff:${record.kickoffKey}:retry:${record.attempts}:${deliveryGeneration}`,
              );
            }
            await this.#recordRunStart(
              session,
              binding,
              `factory-kickoff:${record.kickoffKey}:${record.attempts}`,
              startedBy,
              run.endReason,
              item?.title,
            );
            await this.#reportingRunEnd({ binding, startedBy, since, attempts: record.attempts }, () => run.settle());
          } finally {
            run.close();
          }
        },
      );
      const completed = await this.#storage.completePendingStart(leaseIdentity(record, this.#ownerId), new Date());
      if (!completed) throw new Error('Factory kickoff lease was lost before completion.');
    } catch (error) {
      const failureCode = factoryDispatchFailureCode(error);
      await this.#storage.failPendingStart({
        ...leaseIdentity(record, this.#ownerId),
        now: new Date(),
        availableAt: retryAt(now, record.attempts),
        lastError: sanitizeDispatchError(error),
        failureCode,
        terminal: isTerminalFailure(record.attempts, failureCode),
      });
    }
  }
}

export const FACTORY_DISPATCH_CONSTANTS = {
  leaseMs: LEASE_MS,
  pollMs: POLL_MS,
  batchSize: BATCH_SIZE,
  maxAttempts: MAX_ATTEMPTS,
  maxErrorLength: MAX_ERROR_LENGTH,
  maxBackoffMs: MAX_BACKOFF_MS,
  skillCompletionObservationTimeoutMs: SKILL_COMPLETION_OBSERVATION_TIMEOUT_MS,
  runRegistryHeartbeatMs: RUN_REGISTRY_HEARTBEAT_MS,
  openRunStaleMs: FACTORY_OPEN_RUN_STALE_MS,
  maxInFlight: MAX_IN_FLIGHT,
  reviewStatusTimeoutMs: REVIEW_STATUS_TIMEOUT_MS,
} as const;
