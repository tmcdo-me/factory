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
  if (call.gate) return { kind: 'tool_approval', toolName: call.toolName, input: call.args ?? null, gate: true };
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
  /** The session holds a new call for a person, or holds again one it had let go of. */
  requested(interaction: PendingInteraction & { heldBy: string }): void;
  /**
   * The session no longer shows the call as waiting, and its outcome isn't known yet (an answer is
   * on its way to the tool): stop listing it while it settles.
   */
  left?(toolCallId: string): void;
  /**
   * The session no longer holds the call, or the call it held finished. `settlement` says how,
   * given what the call asked.
   */
  settled(toolCallId: string, settlement: (request: InteractionRequest) => HeldSettlement): void;
}

/**
 * How long a call that left the session's display state waits for its outcome (the answered tool's
 * end) before it is settled anyway: approved for a gate (its tool may run for long), else as no
 * longer waited on.
 */
export const LEAVING_GRACE_MS = 15_000;

type DisplaySnapshot = {
  pendingApprovals?: unknown;
  pendingSuspensions?: unknown;
  /** The calls the run is carrying on, by tool call id. */
  activeTools?: unknown;
};

/** The calls a snapshot says the run is carrying on (running, or ended with a result). */
function carriedOn(snapshot: DisplaySnapshot): Set<string> {
  const ids = new Set<string>();
  for (const [toolCallId, entry] of entries(snapshot.activeTools)) {
    if (isRecord(entry) && entry.status === 'streaming_input') continue;
    ids.add(toolCallId);
  }
  return ids;
}

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
 * snapshot it publishes (the state its own UI renders). A call that leaves the snapshot is let go of
 * (`left`) but settled only by its outcome: its `tool_end` (with the answer read from its result,
 * which also settles one the session took up again after a restart without holding it in its
 * display state), a cancellation, the run aborting or failing, a thread switch, or after a grace
 * window (a gate's tool is then running: it was approved). A call that comes back into the snapshot
 * (a resume that failed) is reported waiting again, and one whose kind changed is settled and asked
 * anew. Returns the unsubscribe function.
 */
export function observeMastraCodeInteractions(
  session: InteractionWatchSession,
  sink: MastraCodeInteractionSink,
  options: { now?: () => Date; onError?(error: unknown): void; graceMs?: number } = {},
): () => void {
  const sessionId = session.identity.getId();
  const now = options.now ?? (() => new Date());
  const graceMs = options.graceMs ?? LEAVING_GRACE_MS;
  /** The calls reported waiting, by tool call id: the kind each was reported as, and whether it is a gate. */
  const open = new Map<string, { kind: InteractionRequest['kind']; gate: boolean }>();
  /** Calls that left the snapshot, awaiting their outcome. */
  const leaving = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
  /** The calls the latest snapshot says the run carries on: a gate's only evidence it was approved. */
  let active = new Set<string>();
  const report = (work: () => void) => {
    try {
      work();
    } catch (error) {
      options.onError?.(error);
    }
  };
  const forget = (toolCallId: string) => {
    const left = leaving.get(toolCallId);
    if (left) clearTimeout(left.timer);
    leaving.delete(toolCallId);
    open.delete(toolCallId);
  };
  const settle = (toolCallId: string, settlement: (request: InteractionRequest) => HeldSettlement) => {
    forget(toolCallId);
    report(() => sink.settled(toolCallId, settlement));
  };
  const cancelLeaving = (reason: string) => {
    for (const toolCallId of [...leaving.keys()]) settle(toolCallId, () => ({ status: 'cancelled', reason }));
  };
  const request = (toolCallId: string, call: MastraCodeWaitingCall) => {
    const asked = mastraCodeInteractionRequest(call);
    open.set(toolCallId, { kind: asked.kind, gate: call.gate === true });
    report(() =>
      sink.requested({
        id: mastraCodeInteractionId(asked, toolCallId),
        sessionId,
        callId: toolCallId,
        request: asked,
        requestedAt: now().toISOString(),
        heldBy: MASTRA_CODE_RUNTIME_ID,
      }),
    );
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'display_state_changed') {
      const snapshot = (event.displayState ?? {}) as DisplaySnapshot;
      const calls = waitingCalls(snapshot);
      active = carriedOn(snapshot);
      for (const [toolCallId, call] of calls) {
        const kind = mastraCodeInteractionRequest(call).kind;
        const reported = open.get(toolCallId);
        if (reported?.kind === kind && !leaving.has(toolCallId)) continue;
        if (reported !== undefined && reported.kind !== kind) {
          // The same call now asks something else (a gate, then the tool's own question): a gate it
          // passed was approved, anything else is no longer asked.
          const wasGate = reported.gate;
          settle(toolCallId, asked =>
            wasGate && asked.kind === 'tool_approval'
              ? { status: 'resolved', response: { kind: 'tool_approval', approved: true } }
              : { status: 'cancelled', reason: HELD_INTERACTION_GONE },
          );
        } else {
          const left = leaving.get(toolCallId);
          if (left) clearTimeout(left.timer);
          leaving.delete(toolCallId);
        }
        request(toolCallId, call);
      }
      for (const [toolCallId, { gate }] of open) {
        if (calls.has(toolCallId) || leaving.has(toolCallId)) continue;
        // A gate that let its call through (a decline or an abort ends the call at once, denied). Only
        // a run still carrying the call on says so: a run parked or detached without it approved nothing.
        const timer = setTimeout(
          () =>
            settle(toolCallId, asked =>
              gate && asked.kind === 'tool_approval' && active.has(toolCallId)
                ? { status: 'resolved', response: { kind: 'tool_approval', approved: true } }
                : { status: 'cancelled', reason: HELD_INTERACTION_GONE },
            ),
          graceMs,
        );
        (timer as { unref?: () => void }).unref?.();
        leaving.set(toolCallId, { timer });
        report(() => sink.left?.(toolCallId));
      }
      return;
    }
    if (event.type === 'tool_end') {
      const { result } = event;
      const denied = event.denied === true;
      const gate = open.get(event.toolCallId)?.gate === true;
      settle(event.toolCallId, request => {
        // A gated call that ran was approved, whether or not it then failed.
        if (gate && !denied && request.kind === 'tool_approval') {
          return { status: 'resolved', response: { kind: 'tool_approval', approved: true } };
        }
        // A call that failed, or a paused one its run dropped (an abort ends it denied), was never
        // answered; a gated call that was denied was declined.
        const answered = !event.isError && (!denied || request.kind === 'tool_approval');
        const response = answered ? answeredResponse(request, result, denied) : undefined;
        return response
          ? { status: 'resolved', response }
          : { status: 'cancelled', reason: errorText(result) || HELD_INTERACTION_GONE };
      });
      return;
    }
    if (event.type === 'tool_suspension_cancelled') {
      const reason = event.reason || HELD_INTERACTION_GONE;
      settle(event.toolCallId, () => ({ status: 'cancelled', reason }));
      return;
    }
    if (event.type === 'agent_end' && (event.reason === 'aborted' || event.reason === 'error')) {
      cancelLeaving(HELD_INTERACTION_GONE);
      return;
    }
    if (event.type === 'thread_changed') cancelLeaving(HELD_INTERACTION_GONE);
  });
  return () => {
    for (const { timer } of leaving.values()) clearTimeout(timer);
    leaving.clear();
    unsubscribe();
  };
}

/** The slice of a Mastra `Session` that tells whether it still waits on a call, without claiming it. */
export interface MastraCodeWaitCheckSession {
  approval: { list(): Array<{ toolCallId: string }> };
  suspensions: { resolveAddress(input: { toolCallId: string }): unknown };
  /** A call paused by a process that has since gone away is only in storage until this finds it. */
  restoreStoredToolSuspension?(toolCallId?: string): Promise<void>;
  /** A gated call whose run was parked by a process that has since gone away. */
  hasPersistedToolApproval?(toolCallId: string): Promise<boolean>;
}

/**
 * Whether a Mastra Code session still waits on a call it held, as its controller (and its storage,
 * for a call parked before a restart) says: a gate it holds or persisted, or a paused call it holds
 * or can find stored. Nothing is claimed or answered. `undefined` when this session can't tell.
 */
export async function mastraCodeStillWaits(
  session: MastraCodeWaitCheckSession,
  toolCallId: string,
): Promise<boolean | undefined> {
  if (session.approval.list().some(gate => gate.toolCallId === toolCallId)) return true;
  if (session.suspensions.resolveAddress({ toolCallId })) return true;
  if (!session.restoreStoredToolSuspension || !session.hasPersistedToolApproval) return undefined;
  if (await session.hasPersistedToolApproval(toolCallId)) return true;
  await session.restoreStoredToolSuspension(toolCallId);
  return Boolean(session.suspensions.resolveAddress({ toolCallId }));
}
