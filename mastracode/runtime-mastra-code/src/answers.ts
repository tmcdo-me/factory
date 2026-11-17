import type { CommandResult, InteractionRecord, InteractionResponse } from '@factory/agent-runtime';
import type { RequestContext } from '@mastra/core/request-context';

/** Where a paused call waits in the controller: its run's address. */
export interface MastraCodeSuspensionAddress {
  resourceId: string;
  threadId: string;
  runId: string;
  toolCallId: string;
}

/** The slice of a Mastra `Session` an answer needs: its gates, its paused calls and how each resumes. */
export interface MastraCodeAnswerSession {
  approval: { list(): Array<{ toolCallId: string; toolName: string }> };
  respondToToolApproval(input: {
    decision: 'approve' | 'decline';
    toolCallId: string;
    requestContext?: unknown;
    declineContext?: { reason?: string };
  }): { accepted: true } | { accepted: false; reason: string };
  suspensions: { has(address: MastraCodeSuspensionAddress): boolean };
  /** Takes the right to answer a paused call, so two answers cannot both resume it. */
  claimToolSuspension(
    toolCallId: string,
  ): { accepted: true; address: MastraCodeSuspensionAddress; claimKey: string } | { accepted: false; reason: string };
  releaseToolResponse(claimKey: string): void;
  respondToToolSuspension(input: {
    resumeData: unknown;
    address: MastraCodeSuspensionAddress;
    requestContext?: unknown;
  }): Promise<void>;
  /** A call paused by a process that has since gone away is only in storage until this finds it. */
  restoreStoredToolSuspension?(toolCallId?: string): Promise<void>;
  /** A gated call whose run was parked by a process that has since gone away. */
  hasPersistedToolApproval?(toolCallId: string): Promise<boolean>;
  claimToolResponse?(toolCallId: string): boolean;
  respondToPersistedToolApproval?(input: {
    toolCallId: string;
    approved: boolean;
    requestContext?: unknown;
  }): Promise<void>;
}

const NOT_PENDING: CommandResult = { ok: false, reason: 'not_pending' };

/** What a paused tool resumes on for an answer. */
export function mastraCodeResumeData(response: InteractionResponse): unknown {
  if (response.kind === 'question') return response.answer;
  if (response.kind === 'tool_approval') {
    // A tool that paused itself for a yes or no, rather than waiting at an approval gate.
    return response.approved
      ? { action: 'approved' }
      : { action: 'rejected', ...(response.reason ? { feedback: response.reason } : {}) };
  }
  return {
    action: response.action,
    ...(response.feedback ? { feedback: response.feedback } : {}),
    // submit_plan records these so its result replays the plan the human approved.
    ...(response.plan?.path ? { path: response.plan.path } : {}),
    ...(response.plan?.title ? { title: response.plan.title } : {}),
    ...(response.plan?.content ? { plan: response.plan.content } : {}),
  };
}

/**
 * Answer a call a Mastra Code session holds, as the person did: open its approval gate (with the
 * reason for a decline), or resume the tool that paused itself, as `requestContext`'s user (the
 * session's owner, whoever answered). The controller decides between answers: a paused call is
 * claimed before anything is awaited, so of two answers one resumes it and the other is
 * `not_pending`. The resume is awaited, and one that could not start (the call still waits) is
 * refused with what the person should do. A call parked by a process that has since gone away
 * (a restart) is found in storage first.
 */
export async function answerMastraCodeCall(
  session: MastraCodeAnswerSession,
  record: Pick<InteractionRecord, 'callId' | 'request'>,
  response: InteractionResponse,
  requestContext: unknown,
): Promise<CommandResult> {
  const toolCallId = record.callId;
  if (!toolCallId) return { ok: false, reason: 'invalid', message: 'Name the tool call the interaction waits on' };

  if (response.kind === 'tool_approval' && session.approval.list().some(gate => gate.toolCallId === toolCallId)) {
    const result = session.respondToToolApproval({
      decision: response.approved ? 'approve' : 'decline',
      toolCallId,
      requestContext,
      ...(!response.approved ? { declineContext: { reason: response.reason } } : {}),
    });
    if (result.accepted) return { ok: true };
    return result.reason === 'not_pending'
      ? NOT_PENDING
      : { ok: false, reason: 'invalid', message: `The answer was not accepted (${result.reason}).` };
  }

  if (
    response.kind === 'tool_approval' &&
    record.request.kind === 'tool_approval' &&
    record.request.gate &&
    session.hasPersistedToolApproval &&
    session.respondToPersistedToolApproval
  ) {
    // Its gate is gone with the process that armed it: resume the stored run that owns the call.
    if (!(await session.hasPersistedToolApproval(toolCallId))) return NOT_PENDING;
    if (session.claimToolResponse && !session.claimToolResponse(toolCallId)) return NOT_PENDING;
    try {
      await session.respondToPersistedToolApproval({ toolCallId, approved: response.approved, requestContext });
    } finally {
      session.releaseToolResponse(toolCallId);
    }
    return { ok: true };
  }

  await session.restoreStoredToolSuspension?.(toolCallId);
  // Claimed before anything else is awaited: of two answers arriving together, one resumes the call.
  const claim = session.claimToolSuspension(toolCallId);
  if (!claim.accepted) return NOT_PENDING;
  try {
    await session.respondToToolSuspension({
      resumeData: mastraCodeResumeData(response),
      address: claim.address,
      requestContext,
    });
  } finally {
    session.releaseToolResponse(claim.claimKey);
  }
  // A resume that fails to start reports its error to the session and leaves the call waiting.
  if (session.suspensions.has(claim.address)) {
    return {
      ok: false,
      reason: 'invalid',
      message: `The answer did not reach ${toolNameOf(record.request)}: the session could not carry on and still waits on it. Open the session to see why.`,
    };
  }
  return { ok: true };
}

function toolNameOf(request: InteractionRecord['request']): string {
  if (request.kind === 'plan_approval') return 'submit_plan';
  if (request.kind === 'question') return 'ask_user';
  return request.toolName;
}

/** The slice of an `AgentController` that finds a session to answer, live or after a restart. */
export interface MastraCodeSessionSource<S> {
  init(): Promise<void>;
  getSession(sessionId: string): Promise<(S & { identity: { getResourceId(): string } }) | null | undefined>;
  queryThreadById(input: { threadId: string }): Promise<{ resourceId: string } | null | undefined>;
  createSession(input: {
    id: string;
    resourceId: string;
    ownerId: string;
    threadId?: string;
    resumeOnly: true;
    requestContext?: RequestContext;
  }): Promise<S>;
  readonly id: string;
}

/**
 * The session an answer goes to: the live one, else the one recovered from storage (after a
 * restart), as Mastra's own agent-controller routes find it. `undefined` when none was started.
 */
export async function mastraCodeSessionToAnswer<S>(
  controller: MastraCodeSessionSource<S>,
  sessionId: string,
  requestContext: RequestContext | undefined,
): Promise<S | undefined> {
  await controller.init();
  const live = await controller.getSession(sessionId);
  if (live) return live;
  const thread = await controller.queryThreadById({ threadId: sessionId });
  try {
    return await controller.createSession({
      id: sessionId,
      resourceId: thread?.resourceId ?? sessionId,
      ownerId: controller.id,
      ...(thread ? { threadId: sessionId } : {}),
      resumeOnly: true,
      ...(requestContext ? { requestContext } : {}),
    });
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === 'SESSION_NOT_STARTED') return undefined;
    throw error;
  }
}
