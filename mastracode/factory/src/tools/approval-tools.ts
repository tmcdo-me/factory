import type { InteractionRequest } from '@factory/agent-runtime';
import type { SuspensionAddress } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { IntegrationTools } from '../integrations/base.js';
import type { SourceControlSessionLookup } from '../session/factory-session.js';
import { checkedAnswer, pausedCalls, pausedToolInteraction } from '../session/parked-interaction.js'; // fork(claude-agent)
import type { AuditRecorder } from '../storage/domains/audit/domain.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';
import type { FactoryMessaging } from './messaging-tools.js';
import { resumesOnDecision } from './run-watch.js';
import { requirePerson } from './scope.js';
import type { FactoryToolScope } from './scope.js';

export interface FactoryApprovalToolDependencies {
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  workItems: Pick<WorkItemsStorage, 'findActiveRunBindingForSession' | 'listSessionSubscriptions'> &
    // fork(claude-agent): who filed a card, who may answer its session's question.
    Partial<Pick<WorkItemsStorage, 'getForProject'>>;
  auditRecorder: AuditRecorder;
  messaging: () => Promise<FactoryMessaging | null>;
}

/** The parts of a live session an answer needs: the calls it waits on, and how each is answered. */
interface ApprovalGateSession {
  approval: { list(): Array<{ toolCallId: string; toolName: string }> };
  displayState: {
    get(): {
      pendingSuspensions: Map<
        string,
        { toolCallId: string; toolName: string; resumeSchema?: string; suspendPayload?: unknown }
      >;
    };
  };
  respondToToolApproval(input: {
    decision: 'approve' | 'decline';
    toolCallId: string;
    requestContext?: RequestContext;
    declineContext?: { reason?: string };
  }): { accepted: true } | { accepted: false; reason: string };
  suspensions: { has(address: SuspensionAddress): boolean };
  /** Takes the right to answer a paused call, so two answers cannot both resume it. */
  claimToolSuspension(
    toolCallId: string,
  ): { accepted: true; address: SuspensionAddress; claimKey: string } | { accepted: false; reason: string };
  releaseToolResponse(claimKey: string): void;
  respondToToolSuspension(input: {
    // fork(claude-agent): a question resumes on its answer.
    resumeData: { action: 'approved' | 'rejected'; feedback?: string } | string | string[];
    address: SuspensionAddress;
    requestContext?: RequestContext;
  }): Promise<void>;
}

const ALREADY_ANSWERED = 'That call was already answered: someone else got there first.';

/** A tool call waiting for a yes or no, and which of the session's two channels answers it. */
interface WaitingApproval {
  toolCallId: string;
  toolName: string;
  /** `gate`: the call has not run yet. `resume`: the tool paused itself to ask. */
  channel: 'gate' | 'resume';
}

function waitingApprovals(live: ApprovalGateSession): WaitingApproval[] {
  return [
    ...live.approval.list().map(({ toolCallId, toolName }) => ({ toolCallId, toolName, channel: 'gate' as const })),
    // Keyed by run address, not tool call id: read the id off each entry.
    ...[...live.displayState.get().pendingSuspensions.values()]
      .filter(suspension => resumesOnDecision(suspension.resumeSchema))
      .map(({ toolCallId, toolName }) => ({ toolCallId, toolName, channel: 'resume' as const })),
  ];
}

// fork(claude-agent): shared by Mastra Code's live sessions and Claude Agent's broker.
const NOTHING_WAITING_ON_CALL =
  'Nothing is waiting on that tool call any more: the run that asked has ended or it was already answered. ' +
  'Message the session with factory_signal_session if it should try again.';
const NOTHING_WAITING = 'This session is not waiting on an approval. Open it to see what it needs.';

/** The call an answer is for: the one named, else the session's only waiting call. */
function theWaitingCall<Call extends { toolCallId: string; toolName: string }>(
  waiting: Call[],
  toolCallId: string | undefined,
  nothingWaiting: string = NOTHING_WAITING, // fork(claude-agent)
): Call {
  const matches = toolCallId ? waiting.filter(call => call.toolCallId === toolCallId) : waiting;
  const [call] = matches;
  if (!call) throw new Error(toolCallId ? NOTHING_WAITING_ON_CALL : nothingWaiting);
  if (matches.length > 1) {
    throw new Error(
      `This session waits on ${matches.length} ${nothingWaiting === NOTHING_WAITING ? 'approvals' : 'questions'} (${matches.map(match => `${match.toolName}: ${match.toolCallId}`).join(', ')}). Name the toolCallId to answer.`,
    );
  }
  return call;
}

/**
 * Approve or decline a tool call a live session waits on, for a caller already allowed
 * to. Any tool can wait this way; with no `toolCallId` the session's only waiting call
 * is answered. The answered run carries on as the session's owner whoever answers: a
 * phase session keeps one identity from kickoff to finish, and a resume never runs with
 * no user.
 */
export async function answerParkedCall(
  deps: Pick<FactoryApprovalToolDependencies, 'messaging'>,
  input: {
    session: { sessionId: string; userId: string; orgId: string };
    toolCallId?: string;
    decision: 'approve' | 'decline';
    declineReason: string;
    /** fork(claude-agent): who decided, recorded with the answer. */
    answeredBy?: string;
  },
): Promise<{ toolCallId: string; toolName: string }> {
  const { session, decision, declineReason } = input;
  const messaging = await deps.messaging();
  if (!messaging) throw new Error('Answering approvals is not available on this server.');
  const requestContext = ownerContext(session);
  // fork(claude-agent): a Claude Agent session's calls wait in Factory's interaction broker.
  const approvals = messaging.runtime?.approvals;
  if (approvals && (await messaging.runtime!.runs(session.sessionId))) {
    const { toolCallId, toolName } = theWaitingCall(await approvals.waiting(session.sessionId), input.toolCallId);
    const answered = await approvals.answer(
      session.sessionId,
      toolCallId,
      {
        decision,
        ...(decision === 'decline' ? { reason: declineReason } : {}),
        ...(input.answeredBy ? { answeredBy: input.answeredBy } : {}),
      },
      requestContext,
    );
    if (answered === 'not_pending') throw new Error(ALREADY_ANSWERED);
    return { toolCallId, toolName };
  }
  const live = (await messaging.controller.getSession(session.sessionId)) as ApprovalGateSession | null;
  const call = theWaitingCall(live ? waitingApprovals(live) : [], input.toolCallId);
  if (!live) throw new Error(NOTHING_WAITING);
  const { toolCallId, toolName } = call;
  if (call.channel === 'resume') {
    await resumePausedCall(
      live,
      call,
      decision === 'approve' ? { action: 'approved' } : { action: 'rejected', feedback: declineReason },
      requestContext,
    );
    return { toolCallId, toolName };
  }
  const result = live.respondToToolApproval({
    decision,
    toolCallId,
    requestContext,
    ...(decision === 'decline' ? { declineContext: { reason: declineReason } } : {}),
  });
  if (!result.accepted) {
    throw new Error(
      result.reason === 'not_pending' ? ALREADY_ANSWERED : `The answer was not accepted (${result.reason}).`,
    );
  }
  return { toolCallId, toolName };
}

/** Resume a paused Mastra Code call with `resumeData`, as the session's owner (`requestContext`). */
async function resumePausedCall(
  live: ApprovalGateSession,
  { toolCallId, toolName }: { toolCallId: string; toolName: string },
  resumeData: Parameters<ApprovalGateSession['respondToToolSuspension']>[0]['resumeData'],
  requestContext: RequestContext,
): Promise<void> {
  // Claimed before anything is awaited: of two answers arriving together, one resumes the call.
  const claim = live.claimToolSuspension(toolCallId);
  if (!claim.accepted) throw new Error(ALREADY_ANSWERED);
  try {
    await live.respondToToolSuspension({ resumeData, address: claim.address, requestContext });
  } finally {
    live.releaseToolResponse(claim.claimKey);
  }
  // A resume that fails to start reports its error to the session and leaves the call waiting.
  if (live.suspensions.has(claim.address)) {
    throw new Error(
      `The answer did not reach ${toolName}: the session could not carry on and still waits on it. Open the session to see why.`,
    );
  }
}

/** The run's identity when an answer resumes it: always the session's owner. */
function ownerContext(session: { userId: string; orgId: string }): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set('user', { workosId: session.userId, organizationId: session.orgId });
  return requestContext;
}

// fork(claude-agent)
const NOTHING_ASKED = 'This session is not waiting on a question. Open it to see what it needs.';

/** fork(claude-agent): the questions (`ask_user`) a live Mastra Code session waits on. */
function waitingQuestions(live: ApprovalGateSession): AnsweredQuestion[] {
  return pausedCalls(live.displayState.get().pendingSuspensions).flatMap(call => {
    const interaction = pausedToolInteraction(call);
    return interaction?.request.kind === 'question'
      ? [{ toolCallId: call.toolCallId, toolName: call.toolName, request: interaction.request }]
      : [];
  });
}

/** fork(claude-agent): a question a session waits on, named by its tool call and/or interaction id. */
export interface AnsweredQuestion {
  toolCallId?: string;
  interactionId?: string;
  toolName: string;
  /** What it asks (the answer is checked against it). */
  request?: InteractionRequest;
}

/** fork(claude-agent): the one question an answer is for: the one named, else the session's only one. */
function theWaitingQuestion(
  waiting: AnsweredQuestion[],
  target: { toolCallId?: string; interactionId?: string },
): AnsweredQuestion {
  const named = target.toolCallId !== undefined || target.interactionId !== undefined;
  const matches = waiting.filter(
    question =>
      (target.toolCallId === undefined || question.toolCallId === target.toolCallId) &&
      (target.interactionId === undefined || question.interactionId === target.interactionId),
  );
  const [question] = matches;
  if (!question) throw new Error(named ? NOTHING_WAITING_ON_CALL : NOTHING_ASKED);
  if (matches.length > 1) {
    const ids = matches.map(match => match.toolCallId ?? match.interactionId).join(', ');
    throw new Error(`This session waits on ${matches.length} questions (${ids}). Name the one to answer.`);
  }
  return question;
}

/**
 * fork(claude-agent): answer a question a session waits on, for a caller already allowed to, on
 * either runtime: an `ask_user` call, named by its `toolCallId`, or (Claude Agent) a question a run's
 * turn ended on in plain text, named by its `interactionId`. Naming neither answers the session's
 * only question. The run carries on as the session's owner whoever answers, as an approval does.
 */
export async function answerParkedQuestion(
  deps: Pick<FactoryApprovalToolDependencies, 'messaging'>,
  input: {
    session: { sessionId: string; userId: string; orgId: string };
    toolCallId?: string;
    interactionId?: string;
    answer: string | string[];
    /** Who answered, recorded with the answer. */
    answeredBy?: string;
    /** Their name, told to a Mastra Code session when they aren't its owner. */
    answeredByName?: string;
  },
): Promise<AnsweredQuestion> {
  const { session, answer } = input;
  const target = {
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
  };
  const messaging = await deps.messaging();
  if (!messaging) throw new Error('Answering questions is not available on this server.');
  const requestContext = ownerContext(session);
  const questions = messaging.runtime?.questions;
  if (questions && (await messaging.runtime!.runs(session.sessionId))) {
    const question = theWaitingQuestion(await questions.waiting(session.sessionId), target);
    const checked = question.request ? checkedAnswer(question.request, answer) : answer;
    const answered = await questions.answer(
      session.sessionId,
      {
        ...(question.toolCallId ? { toolCallId: question.toolCallId } : {}),
        ...(question.interactionId ? { interactionId: question.interactionId } : {}),
      },
      // The broker records who answered; the transcript shows it.
      { answer: checked, ...(input.answeredBy ? { answeredBy: input.answeredBy } : {}) },
      requestContext,
    );
    if (answered === 'not_pending') throw new Error(ALREADY_ANSWERED);
    return idsOf(question);
  }
  const live = (await messaging.controller.getSession(session.sessionId)) as ApprovalGateSession | null;
  const question = theWaitingQuestion(live ? waitingQuestions(live) : [], target);
  const checked = question.request ? checkedAnswer(question.request, answer) : answer;
  const call = { toolCallId: question.toolCallId!, toolName: question.toolName };
  // Mastra Code keeps no record of who answered: someone other than the owner says so in the answer.
  const resumeData =
    input.answeredBy && input.answeredBy !== session.userId
      ? `Answered by ${input.answeredByName ?? input.answeredBy}: ${Array.isArray(checked) ? checked.join(', ') : checked}`
      : checked;
  await resumePausedCall(live!, call, resumeData, requestContext);
  return call;
}

/** A question's ids and tool, without what it asks. */
function idsOf({ toolCallId, interactionId, toolName }: AnsweredQuestion): AnsweredQuestion {
  return { ...(toolCallId ? { toolCallId } : {}), ...(interactionId ? { interactionId } : {}), toolName };
}

/**
 * fork(claude-agent): the owner's rule for a typed answer: only the session's owner, an org admin
 * or the person who filed its card may answer its question. A follower may still approve or
 * decline its plans and gated calls (upstream's rule), not answer for the owner in words.
 * (Tool callers have no admin check: an admin answers on the web.)
 */
export const QUESTION_ANSWERERS =
  "Only the session's owner, an organization admin, or the person who filed its card can answer its question; a follower can approve or decline its plans and tool calls.";

/**
 * The session a caller's turn may answer: one in this Factory it can see, that reports to the
 * caller's session (its origin, or a follower of its card). Only a signed-in person's turn may answer.
 */
async function answerableSession(
  scope: FactoryToolScope,
  deps: FactoryApprovalToolDependencies,
  sessionId: string,
  what: string,
) {
  requirePerson(scope, what);
  // fork(claude-agent): a session never answers what it is waiting on itself.
  if (sessionId === scope.sessionId) {
    throw new Error('This is the session that is waiting: the person answers it here, not through a tool.');
  }
  const row = await deps.sessions.getBySessionId(sessionId);
  if (!row || row.orgId !== scope.orgId || row.factoryProjectId !== scope.factoryProjectId) {
    throw new Error(`Session ${sessionId} was not found in this Factory.`);
  }
  if (row.visibility === 'private' && row.userId !== scope.userId) {
    throw new Error(`Session ${sessionId} is private to its owner.`);
  }

  // Only the sessions it reports to may answer it: its origin, or followers of its item.
  const binding = await deps.workItems.findActiveRunBindingForSession({
    orgId: scope.orgId,
    factoryProjectId: scope.factoryProjectId,
    sessionId,
  });
  const isOrigin = row.originSessionId === scope.sessionId;
  const follows =
    binding !== null &&
    (
      await deps.workItems.listSessionSubscriptions({
        orgId: scope.orgId,
        factoryProjectId: scope.factoryProjectId,
        sessionId: scope.sessionId,
      })
    ).some(subscription => subscription.workItemId === binding.workItemId);
  if (!isOrigin && !follows) {
    throw new Error(
      `This session doesn't follow session ${sessionId}: follow its work item first, or answer from that session.`,
    );
  }
  return { row, binding };
}

/** A person's answer to a session's question: text, or the option labels they picked. */
export const questionAnswerSchema = z.union([
  z.string().trim().min(1).max(4000),
  z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
]);

/** Answers a tool call or question another session holds. Only a signed-in person's turn may answer. */
export function createFactoryApprovalTools(
  scope: FactoryToolScope,
  deps: FactoryApprovalToolDependencies,
): IntegrationTools {
  const answer = createTool({
    id: 'factory_answer_approval',
    description: [
      'Approve or decline a tool call a session you follow is waiting on.',
      'The decision is recorded as yours; the run carries on as the owner of the session that asked.',
      'A `factory-session` notification of kind `approval` names the session, tool, arguments and toolCallId;',
      'a `blocked` notice for a session parked on a tool that waits for approval names the toolCallId to approve or decline;',
      'factory_list_attention lists each waiting session with its toolCallId.', // fork(claude-agent)
      'A question (ask_user) takes an answer instead: use factory_answer_question.', // fork(claude-agent)
      'Answer only what the person in this conversation agreed to; decline with a reason the session will see.',
    ].join(' '),
    inputSchema: z
      .object({
        sessionId: z.string().uuid().describe('The session holding the call, from the approval notice.'),
        toolCallId: z.string().trim().min(1).max(200),
        decision: z.enum(['approve', 'decline']),
        reason: z.string().trim().min(1).max(1000).optional().describe('Why, when declining.'),
      })
      .strict(),
    execute: async ({ sessionId, toolCallId, decision, reason }) => {
      // fork(claude-agent): shared with factory_answer_question.
      const { row, binding } = await answerableSession(scope, deps, sessionId, 'answer an approval');

      await answerParkedCall(deps, {
        session: row,
        toolCallId,
        decision,
        declineReason: reason ?? 'Declined by a session following it.',
        answeredBy: scope.userId, // fork(claude-agent)
      });

      deps.auditRecorder.record({
        orgId: scope.orgId,
        actorId: scope.userId,
        actorType: 'human',
        ...(scope.actorProfile ? { actorProfile: scope.actorProfile } : {}),
        action: decision === 'approve' ? 'factory.run.approved' : 'factory.run.dismissed',
        factoryProjectId: scope.factoryProjectId,
        targets: [
          { type: 'session', id: sessionId },
          ...(binding ? [{ type: 'work_item' as const, id: binding.workItemId }] : []),
        ],
        metadata: { toolCallId, sessionId, decision, cause: 'factory_tools' },
      });
      return { answered: decision, sessionId, toolCallId };
    },
  });

  // fork(claude-agent): a question a followed session asked (ask_user), answered from here.
  const answerQuestion = createTool({
    id: 'factory_answer_question',
    description: [
      'Answer a question a session you follow is waiting on, on either agent runtime:',
      'an ask_user call (name its toolCallId), or a question a run ended its turn on in plain text (name its interactionId).',
      'factory_list_attention lists each waiting session with its question, options, toolCallId and interactionId;',
      'a `blocked` notice for a session parked on ask_user names the toolCallId.',
      'Give the answer as text, or as the labels of the options picked (several only when the question allows several).',
      'The answer is recorded as yours; the run carries on as the owner of the session that asked.',
      "Only the asking session's owner or the person who filed its card may answer it (a follower may only approve or decline plans and tool calls).",
      'Answer only what the person in this conversation told you to answer.',
    ].join(' '),
    inputSchema: z
      .object({
        sessionId: z.string().uuid().describe('The session that asked, from factory_list_attention or its notice.'),
        toolCallId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('The ask_user call, from factory_list_attention.'),
        interactionId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('The question, from factory_list_attention, when no tool call asked it.'),
        answer: questionAnswerSchema.describe('The answer text, or the labels of the options picked.'),
      })
      .strict()
      .refine(input => input.toolCallId !== undefined || input.interactionId !== undefined, {
        message: 'Name the question: its toolCallId, or its interactionId when no tool call asked it.',
      }),
    execute: async ({ sessionId, toolCallId, interactionId, answer: reply }) => {
      const { row, binding } = await answerableSession(scope, deps, sessionId, 'answer a question');
      // The owner's rule for answering in words (see QUESTION_ANSWERERS).
      const filed =
        binding !== null &&
        (await deps.workItems.getForProject?.(scope.orgId, scope.factoryProjectId, binding.workItemId))?.createdBy ===
          scope.userId;
      if (row.userId !== scope.userId && !filed) throw new Error(QUESTION_ANSWERERS);

      const answered = await answerParkedQuestion(deps, {
        session: row,
        ...(toolCallId ? { toolCallId } : {}),
        ...(interactionId ? { interactionId } : {}),
        answer: reply,
        answeredBy: scope.userId,
        ...(scope.actorProfile?.name ? { answeredByName: scope.actorProfile.name } : {}),
      });

      deps.auditRecorder.record({
        orgId: scope.orgId,
        actorId: scope.userId,
        actorType: 'human',
        ...(scope.actorProfile ? { actorProfile: scope.actorProfile } : {}),
        action: 'factory.run.answered',
        factoryProjectId: scope.factoryProjectId,
        targets: [
          { type: 'session', id: sessionId },
          ...(binding ? [{ type: 'work_item' as const, id: binding.workItemId }] : []),
        ],
        metadata: {
          ...(answered.toolCallId ? { toolCallId: answered.toolCallId } : {}),
          ...(answered.interactionId ? { interactionId: answered.interactionId } : {}),
          toolName: answered.toolName,
          sessionId,
          cause: 'factory_tools',
        },
      });
      return {
        answered: true,
        sessionId,
        ...(answered.toolCallId ? { toolCallId: answered.toolCallId } : {}),
        ...(answered.interactionId ? { interactionId: answered.interactionId } : {}),
      };
    },
  });

  return { factory_answer_approval: answer, factory_answer_question: answerQuestion };
}
