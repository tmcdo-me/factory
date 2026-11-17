// fork(claude-agent): watching a Mastra Code run to its end, moved out of the dispatcher so the Mastra Code
// adapter (`mastra-code-sessions.ts`) and the dispatcher's open-run waits share it.
import { isSessionEvent } from '@factory/agent-runtime';
import type { RuntimeSessionEvents } from '@factory/agent-runtime';
import { classifyProviderError, PROVIDER_CALL_ERROR_NAME } from '@mastra/core/error';

import type { FactoryDispatchFailureCode } from '../storage/domains/work-items/base.js';
import { FactoryDispatchError } from './dispatch-errors.js';

// Enough for a run that re-plans after reading its own approval, few enough
// that an agent looping on submit_plan reaches a person instead of a bill.
export const MAX_PLAN_APPROVALS = 3;
// A run the registry no longer shows never started or ended unobserved:
// checked at this cadence, and failed for retry.
export const RUN_REGISTRY_HEARTBEAT_MS = 10 * 60_000;

/** The card moved on before this run could act; it settles as superseded, not succeeded. */
export class FactoryDecisionSuperseded extends Error {}

/** A run that ran and ended in error; the session's own listener reports it to followers. */
export class RunEndedInError extends FactoryDispatchError {}

// The Mastra Code credential resolver's own failure; free text that merely mentions credentials does not count.
const CREDENTIAL_RESOLUTION_FAILURE = 'tenant model credential policy could not be resolved';
// The resolver's reason when the request context has no user; it recurs on every retry of the same start.
const NO_AUTHENTICATED_USER = 'the request has no authenticated user';

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

function causeOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
}

function isProviderCallError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('name' in error && typeof error.name === 'string' && PROVIDER_CALL_ERROR_NAME.test(error.name)) return true;
  return 'statusCode' in error || 'responseBody' in error;
}

function runErrorCode(error: unknown, message: string): FactoryDispatchFailureCode {
  const lower = message.toLowerCase();
  if (lower.includes(CREDENTIAL_RESOLUTION_FAILURE)) {
    return lower.includes(NO_AUTHENTICATED_USER) ? 'run_user_unauthenticated' : 'run_credentials_unavailable';
  }
  const status = httpStatus(error) ?? httpStatus(causeOf(error));
  if (status === 401 || status === 403) return 'run_credentials_unavailable';
  const providerCall = isProviderCallError(error) || isProviderCallError(causeOf(error));
  return providerCall && classifyProviderError(error) === 'auth' ? 'run_credentials_unavailable' : 'run_failed';
}

export function runErrorFailure(label: string, error: unknown): RunEndedInError {
  const cause = (error instanceof Error ? error.message : String(error ?? '')).trim();
  if (!cause) return new RunEndedInError('run_failed', `${label} ended in error.`);
  return new RunEndedInError(runErrorCode(error, cause), `${label} ended in error: ${cause}`);
}

/**
 * Conservative check for observational-memory failures that a retry cannot fix:
 * a provider rejecting the request outright (HTTP 400 / model unsupported /
 * authentication). Anything ambiguous (timeouts, 5xx, rate limits, network
 * blips) is intentionally left retryable to avoid dead-ending a card that would
 * have recovered on its own.
 */
export function isPermanentProviderRejection(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    /\bhttp(?:\/\d(?:\.\d)?)?\s*400\b/.test(normalized) ||
    /\bstatus(?:\s*code)?\s*[:=]?\s*400\b/.test(normalized) ||
    /\b400\s*(?:bad request|status)\b/.test(normalized) ||
    normalized.includes('model not supported') ||
    normalized.includes('model is not supported') ||
    normalized.includes('unsupported model') ||
    normalized.includes('not supported with') ||
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    (normalized.includes('invalid') && normalized.includes('model'))
  );
}

/**
 * fork(claude-agent): slice 5d. How a run approves the call it paused on: through the call's
 * interaction broker record. `undefined` when there is nothing it can approve (no record, or one a
 * yes doesn't answer), so the call waits for a person; else the approval, which resolves once the
 * session has it.
 */
export type ApprovePausedCall = (call: {
  toolCallId: string;
  toolName: string;
}) => Promise<(() => Promise<void>) | undefined>;

export function watchRun(
  session: RuntimeSessionEvents,
  {
    timeoutMs,
    autoApprovedTool,
    autoApproving,
    approve,
    onAgentEnd,
    label,
    runStillActive,
  }: {
    timeoutMs: number;
    /** The tool this run answers itself when it pauses on it; any other pause waits for a person. */
    autoApprovedTool?: string;
    /** Where the run says which paused calls it is about to answer. */
    autoApproving?: Set<string>;
    /** fork(claude-agent): how it approves one; without it every pause waits for a person. */
    approve?: ApprovePausedCall;
    onAgentEnd?: () => Promise<boolean>;
    label: string;
    /** Level-triggered check against the run registry, consulted at every heartbeat the edge-triggered wait misses. */
    runStillActive: () => boolean;
  },
) {
  let resolveAgentEnd!: () => void;
  let agentEnd!: Promise<void>;
  let endReason: 'complete' | 'aborted' | 'error' | 'suspended' | undefined;
  let supersededAtEnd: Promise<boolean> | undefined;
  let parked: { toolName: string; toolCallId: string } | undefined;
  let approvals = 0;
  let closed = false;
  const announced = new Set<string>();
  // Latest observational-memory failure seen on this run. The stream aborts the
  // run when observation/reflection fails, but the abort itself carries no
  // reason — so without this the true cause (e.g. a provider rejecting the OM
  // model) is lost and the abort is retried blindly.
  let omFailure: string | undefined;
  // The run's own error event precedes its `agent_end: 'error'` and is the only place the cause appears.
  let runError: unknown;
  // Re-armed before a redelivery so the second send waits on its own run's
  // ending rather than seeing the one that already resolved.
  const arm = () => {
    endReason = undefined;
    supersededAtEnd = undefined;
    omFailure = undefined;
    runError = undefined;
    agentEnd = new Promise<void>(resolve => {
      resolveAgentEnd = resolve;
    });
  };
  arm();
  const unsubscribe = session.subscribe(event => {
    if (isSessionEvent(event, 'agent_end')) {
      endReason = event.reason;
      supersededAtEnd = onAgentEnd?.();
      resolveAgentEnd();
      return;
    }
    if (isSessionEvent(event, 'error')) {
      runError = event.error;
      return;
    }
    if (isSessionEvent(event, 'om_observation_failed') || isSessionEvent(event, 'om_buffering_failed')) {
      if (event.error) omFailure = event.error;
      return;
    }
    if (isSessionEvent(event, 'tool_suspended')) {
      parked = { toolName: event.toolName, toolCallId: event.toolCallId };
      // Said before the run ends on it, so nobody is asked to answer what this run answers itself.
      if (approve && event.toolName === autoApprovedTool && approvals < MAX_PLAN_APPROVALS) {
        announced.add(event.toolCallId);
        autoApproving?.add(event.toolCallId);
      }
      return;
    }
    if (isSessionEvent(event, 'tool_suspension_cancelled') && parked?.toolCallId === event.toolCallId) {
      parked = undefined;
    }
  });
  // Failing a run the registry still shows would kick off a duplicate into a busy session.
  const wait = async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closed) return false;
      const heartbeatMs = Math.min(RUN_REGISTRY_HEARTBEAT_MS, deadline - Date.now());
      if (await waitForAgentEndOrTimeout(agentEnd, heartbeatMs)) return !closed;
      if (!runStillActive()) return false;
    }
    throw new FactoryDispatchError(
      'run_overdue',
      `${label} is still in flight after ${Math.round(timeoutMs / 3_600_000)} hours and needs a person.`,
    );
  };

  return {
    arm,
    wait,
    supersededAtEnd: () => supersededAtEnd,
    endReason: () => endReason,
    /** The tool the run is parked on, when it ended suspended. */
    parked: () => parked,
    close: () => {
      // A watch that gives up answers nothing more, so its pauses wait for a person again.
      for (const toolCallId of announced) autoApproving?.delete(toolCallId);
      closed = true;
      unsubscribe();
      // A wait in progress ends at once instead of running to its deadline.
      resolveAgentEnd();
    },
    /** The run's own verdict, thrown as what the dispatcher should record. */
    async settle(): Promise<void> {
      let observed = await wait();
      // Past the cap the plan stays parked: the person it waits for sees it in the inbox.
      while (
        !closed &&
        approve &&
        autoApprovedTool &&
        parked?.toolName === autoApprovedTool &&
        approvals < MAX_PLAN_APPROVALS
      ) {
        const { toolCallId, toolName } = parked;
        // fork(claude-agent): answered through its broker record (slice 5d); one it can't answer waits for a person.
        let approval: (() => Promise<void>) | undefined;
        try {
          approval = await approve({ toolCallId, toolName });
        } finally {
          if (!approval) autoApproving?.delete(toolCallId);
        }
        if (!approval) break;
        parked = undefined;
        // Counted before the resumed run can pause again, so its next pause is judged against the cap.
        approvals += 1;
        arm();
        try {
          await approval();
        } finally {
          autoApproving?.delete(toolCallId);
        }
        observed = await wait();
      }
      if (!observed) {
        // A completed decision with no observed run end is exactly the
        // silent-stall failure mode: the card advances while nobody works it.
        // Delivery already began, so retrying with a fresh generation could
        // duplicate work whose terminal event was lost.
        throw new FactoryDispatchError(
          'run_terminal_event_missing',
          `${label} terminal event was not observed before timeout.`,
        );
      }
      if (endReason === 'error') throw runErrorFailure(label, runError);
      if (endReason === 'aborted') {
        // An abort that follows an observational-memory failure is not the
        // usual "process went away" case — the OM stream deliberately aborted
        // the run because observation/reflection failed. Surface that real
        // cause instead of the generic message, and when it is a permanent
        // provider/config rejection (e.g. the OM model is not accepted by the
        // account) fail terminally so retries stop hammering a run that can
        // never succeed until the configuration changes.
        if (omFailure) {
          if (isPermanentProviderRejection(omFailure)) {
            throw new FactoryDispatchError(
              'run_configuration_invalid',
              `${label} was aborted by an observational-memory failure that will not succeed on retry: ${omFailure}`,
            );
          }
          throw new Error(`${label} was aborted after an observational-memory failure: ${omFailure}`);
        }
        // Retryable, though an abort reads as deliberate. The stream does not
        // say who aborted, and in practice the dominant cause is the process
        // going away underneath the run — an operator restarting the server —
        // not anyone deciding this work should stop. Treating that as terminal
        // dead-ends the card at attempt 1 with nothing on the board to press. A
        // spurious retry is bounded by MAX_ATTEMPTS; a dead card costs a human
        // a manual nudge.
        throw new Error(`${label} was aborted before it finished.`);
      }
    },
  };
}

function waitForAgentEndOrTimeout(agentEnd: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
    void agentEnd.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}
