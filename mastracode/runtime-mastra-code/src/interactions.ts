import type {
  HeldSettlement,
  InteractionRequest,
  InteractionResponse,
  PendingInteraction,
} from '@factory/agent-runtime';
import { HELD_INTERACTION_GONE } from '@factory/agent-runtime';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import { MASTRA_CODE_RUNTIME_ID } from './event-mapper';

/**
 * A call a Mastra Code session holds for a person: a gated call that may not run until someone
 * allows it, or a tool that paused itself (`ask_user`, `submit_plan`, `request_access`, …).
 */
export interface MastraCodeWaitingCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  suspendPayload?: unknown;
  resumeSchema?: string;
  /** A gated call (an approval), rather than a tool that paused itself. */
  gate?: boolean;
}

/**
 * Whether a bare yes or no is all a paused tool needs to carry on: its resume data is an object
 * whose `action` is `approved` or `rejected`, and nothing else is required. A question to the
 * person (free text, a choice, a decision plus a required detail) does not fit.
 */
export function resumesOnDecision(resumeSchema: string | undefined): boolean {
  if (!resumeSchema) return false;
  try {
    const schema = JSON.parse(resumeSchema) as { properties?: { action?: { enum?: unknown } }; required?: unknown };
    const actions = schema.properties?.action?.enum;
    const required = Array.isArray(schema.required) ? schema.required : [];
    return (
      Array.isArray(actions) &&
      actions.includes('approved') &&
      actions.includes('rejected') &&
      required.every(field => field === 'action')
    );
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function questionOptions(value: unknown): { label: string; description?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap(option => {
    if (!isRecord(option)) return [];
    const { label, description } = option;
    if (typeof label !== 'string' || !label) return [];
    return [{ label, ...(typeof description === 'string' && description ? { description } : {}) }];
  });
  return options.length > 0 ? options : undefined;
}

/**
 * What a waiting call asks a person, in the seam's shape: a gated call is a tool approval; a paused
 * tool whose payload carries a question is a question (`ask_user`); `submit_plan`, or another tool
 * that resumes on a bare yes or no, is a plan or tool approval. Anything else resumes on input of its
 * own (`tool_input`), which only its session can give.
 */
export function mastraCodeInteractionRequest(call: MastraCodeWaitingCall): InteractionRequest {
  if (call.gate) return { kind: 'tool_approval', toolName: call.toolName, input: call.args ?? null };
  const payload = isRecord(call.suspendPayload) ? call.suspendPayload : {};
  const decision = resumesOnDecision(call.resumeSchema);
  if (typeof payload.question === 'string' && payload.question && !decision) {
    const options = questionOptions(payload.options);
    return {
      kind: 'question',
      question: payload.question,
      ...(options ? { options } : {}),
      ...(options
        ? { selection: payload.selectionMode === 'multi_select' ? ('multiple' as const) : ('single' as const) }
        : {}),
    };
  }
  if (!decision) return { kind: 'tool_input', toolName: call.toolName, input: call.args ?? null };
  if (call.toolName === 'submit_plan' || payload.toolId === 'submit_plan') {
    return {
      kind: 'plan_approval',
      planPath: typeof payload.path === 'string' ? payload.path : '',
      ...(typeof payload.plan === 'string' && payload.plan ? { plan: payload.plan } : {}),
    };
  }
  return { kind: 'tool_approval', toolName: call.toolName, input: call.args ?? null };
}

/** The interaction id of a waiting call, as the event mirror names it: `<kind>:<toolCallId>`. */
export function mastraCodeInteractionId(request: InteractionRequest, toolCallId: string): string {
  return `${request.kind}:${toolCallId}`;
}

/** The slice of a Mastra `Session` the watch needs. */
export interface InteractionWatchSession {
  identity: { getId(): string };
  subscribe(listener: (event: AgentControllerEvent) => void | Promise<void>): () => void;
}

/** Where a Mastra Code session's waiting calls are reported: Factory's interaction broker. */
export interface MastraCodeInteractionSink {
  /** The session holds a new call for a person. */
  requested(interaction: PendingInteraction & { heldBy: string }): void;
  /**
   * The session no longer holds the call, or the call it held finished. `settlement` says how,
   * given what the call asked.
   */
  settled(toolCallId: string, settlement: (request: InteractionRequest) => HeldSettlement): void;
}

type DisplaySnapshot = {
  pendingApprovals?: unknown;
  pendingSuspensions?: unknown;
};

function entries(value: unknown): Array<[string, unknown]> {
  if (value instanceof Map) return [...value.entries()];
  return isRecord(value) ? Object.entries(value) : [];
}

/** The calls a display-state snapshot says the session waits on, by tool call id. */
function waitingCalls(snapshot: DisplaySnapshot): Map<string, MastraCodeWaitingCall> {
  const calls = new Map<string, MastraCodeWaitingCall>();
  for (const [key, entry] of entries(snapshot.pendingSuspensions)) {
    if (!isRecord(entry) || typeof entry.toolName !== 'string') continue;
    // Keyed by run address: the call's own id is on the entry (legacy entries are keyed by it).
    const toolCallId = typeof entry.toolCallId === 'string' && entry.toolCallId ? entry.toolCallId : key;
    calls.set(toolCallId, {
      toolCallId,
      toolName: entry.toolName,
      args: entry.args,
      suspendPayload: entry.suspendPayload,
      ...(typeof entry.resumeSchema === 'string' ? { resumeSchema: entry.resumeSchema } : {}),
    });
  }
  for (const [key, entry] of entries(snapshot.pendingApprovals)) {
    if (!isRecord(entry) || typeof entry.toolName !== 'string') continue;
    const toolCallId = typeof entry.toolCallId === 'string' && entry.toolCallId ? entry.toolCallId : key;
    if (!calls.has(toolCallId))
      calls.set(toolCallId, { toolCallId, toolName: entry.toolName, args: entry.args, gate: true });
  }
  return calls;
}

function errorText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (isRecord(result) && typeof (result.message ?? result.error) === 'string')
    return String(result.message ?? result.error);
  return '';
}

/** The answer a finished call got, read from its result (Mastra Code keeps no record of it). */
export function answeredResponse(
  request: InteractionRequest,
  result: unknown,
  denied: boolean,
): InteractionResponse | undefined {
  switch (request.kind) {
    case 'tool_approval':
      return { kind: 'tool_approval', approved: !denied };
    case 'plan_approval': {
      const submitted = isRecord(result) && isRecord(result.submittedPlan) ? result.submittedPlan : undefined;
      return {
        kind: 'plan_approval',
        action: submitted?.action === 'approved' ? 'approved' : 'rejected',
        ...(typeof submitted?.feedback === 'string' ? { feedback: submitted.feedback } : {}),
      };
    }
    case 'question':
      return { kind: 'question', answer: typeof result === 'string' ? result : JSON.stringify(result ?? '') };
    case 'tool_input':
      return undefined;
  }
}

/**
 * Report every call a Mastra Code session holds for a person to `sink`, and when it stops holding
 * it. The session's controller stays the authority: what it waits on is read from each display-state
 * snapshot it publishes (the state its own UI renders), so a call it drops without saying so (an
 * abort, a run that ends, a thread reset) is reported settled as well. A call that finishes is
 * reported settled with the answer read from its result, which also settles one the session took up
 * again after a restart without holding it in its display state. Returns the unsubscribe function.
 */
export function observeMastraCodeInteractions(
  session: InteractionWatchSession,
  sink: MastraCodeInteractionSink,
  options: { now?: () => Date; onError?(error: unknown): void } = {},
): () => void {
  const sessionId = session.identity.getId();
  const now = options.now ?? (() => new Date());
  /** The calls reported waiting, by tool call id. */
  const open = new Set<string>();
  const report = (work: () => void) => {
    try {
      work();
    } catch (error) {
      options.onError?.(error);
    }
  };
  return session.subscribe(event => {
    if (event.type === 'display_state_changed') {
      const calls = waitingCalls((event.displayState ?? {}) as DisplaySnapshot);
      for (const [toolCallId, call] of calls) {
        if (open.has(toolCallId)) continue;
        open.add(toolCallId);
        const request = mastraCodeInteractionRequest(call);
        report(() =>
          sink.requested({
            id: mastraCodeInteractionId(request, toolCallId),
            sessionId,
            callId: toolCallId,
            request,
            requestedAt: now().toISOString(),
            heldBy: MASTRA_CODE_RUNTIME_ID,
          }),
        );
      }
      for (const toolCallId of [...open]) {
        if (calls.has(toolCallId)) continue;
        open.delete(toolCallId);
        report(() => sink.settled(toolCallId, () => ({ status: 'cancelled', reason: HELD_INTERACTION_GONE })));
      }
      return;
    }
    if (event.type === 'tool_end') {
      open.delete(event.toolCallId);
      const { result } = event;
      const denied = event.denied === true;
      report(() =>
        sink.settled(event.toolCallId, request => {
          // A call that failed, or a paused one its run dropped (an abort ends it denied), was never
          // answered; a gated call that was denied was declined.
          const answered = !event.isError && (!denied || request.kind === 'tool_approval');
          const response = answered ? answeredResponse(request, result, denied) : undefined;
          return response
            ? { status: 'resolved', response }
            : { status: 'cancelled', reason: errorText(result) || HELD_INTERACTION_GONE };
        }),
      );
    }
  });
}
