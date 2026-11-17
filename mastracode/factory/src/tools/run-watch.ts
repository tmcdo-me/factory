import type { EventEnvelope } from '@factory/agent-runtime';

import { FACTORY_OPEN_RUN_STALE_MS, heartbeatSessionOpenRun, ledgerRunEndReason } from '../session/run-audit.js';
import type { RunEndCaptureSession, RunEndReason, SessionEventListening } from '../session/run-audit.js';
import type { FactoryRunOutcome } from './reports.js';

/** What a run stopped on: a tool waiting for an answer, or one waiting for approval. */
export interface ParkedTool {
  toolName: string;
  toolCallId: string;
  /** The call has not run yet, and waits for a person to allow it. */
  approval: boolean;
}

/** The session whose runs are reported: its id, and the hub its events are heard on. */
export interface RunReportSession {
  sessionId: string;
  events: SessionEventListening;
}

/** Reports one run's end; `since` is when the run's window opened. Should not throw. */
export type SessionRunEndReport = (outcome: FactoryRunOutcome, since: Date) => Promise<void>;

/** How much of a run's error message a `failed` report quotes. */
const ERROR_MESSAGE_LENGTH = 400;

/**
 * Report every run end of a session, however the run started: the board, a
 * typed message, a wake, or a run after a restart. Attached to each Factory
 * session when it is created, so it outlives any one start. A run someone
 * stopped or steered says nothing, and its window carries into the next run,
 * so reports the agent made in it still count.
 *
 * fork(claude-agent): slice 5d. A run that ends parked on a call says nothing either: the call is
 * announced from the interaction broker as the session starts waiting on it (a gate's `approval`,
 * anything else's `blocked`), judged on this run's window, which `onWindow` hands out. The window
 * still closes at that end, as it did when the end was the `blocked` report.
 */
export function observeSessionRunReports(
  session: RunReportSession,
  report: SessionRunEndReport,
  {
    answersItself,
    onWindow,
  }: {
    /** Whether the Factory answers this paused call without a person, so its run carries on and nobody needs telling. */
    answersItself?: (toolCallId: string) => boolean;
    /** fork(claude-agent): told when each run's window opens, the first as the session is observed. */
    onWindow?: (since: Date) => void;
  } = {},
): () => void {
  /** Names of the calls in flight, from `tool.started`: an interaction request carries none for a question. */
  const toolNames = new Map<string, string>();
  /** The call each open interaction belongs to, for its cancellation. */
  const interactionCalls = new Map<string, string>();
  let parked: ParkedTool | undefined;
  let lastError: string | undefined;
  let since = new Date();
  const settle = (work: Promise<void>) =>
    void work.catch(error => {
      console.warn('[Factory reports] Unable to report on a session run.', error);
    });
  onWindow?.(since);
  return session.events.listen(session.sessionId, ({ event }: EventEnvelope) => {
    // fork(claude-agent): slice 6. The parked call is joined with the run's end by the event order of
    // the one stream they share (`tool.started`, `interaction.requested`, then `run.ended`), not by
    // a second pipeline that could land either side first.
    if (event.type === 'tool.started') {
      toolNames.set(event.callId, event.name);
      return;
    }
    if (event.type === 'interaction.requested') {
      const { callId, request } = event.interaction;
      if (!callId) return;
      interactionCalls.set(event.interaction.id, callId);
      parked = {
        toolName:
          request.kind === 'tool_approval' || request.kind === 'tool_input'
            ? request.toolName
            : (toolNames.get(callId) ?? ''),
        toolCallId: callId,
        approval: request.kind === 'tool_approval',
      };
      return;
    }
    if (event.type === 'interaction.cancelled') {
      const callId = interactionCalls.get(event.interactionId);
      interactionCalls.delete(event.interactionId);
      if (callId && parked?.toolCallId === callId) parked = undefined;
      return;
    }
    if (event.type === 'tool.ended') {
      toolNames.delete(event.callId);
      return;
    }
    if (event.type === 'error') {
      // The failure's text, as `run.ended` carries it, is the more exact; this is the fallback.
      lastError = event.message;
      return;
    }
    if (event.type !== 'run.ended') return;
    const outcome = runOutcome(ledgerRunEndReason(event.reason), parked, event.error ?? lastError);
    parked = undefined;
    lastError = undefined;
    if (!outcome) return;
    // Not an end: the Factory answers the call and the same run carries on in its window.
    if (outcome.status === 'blocked' && outcome.toolCallId && answersItself?.(outcome.toolCallId)) return;
    // Move the window now, so a run that starts before this report settles is judged on its own;
    // reports made up to the end, including its last millisecond, belong to the run that ended.
    const runSince = since;
    since = new Date(Date.now() + 1);
    onWindow?.(since);
    // fork(claude-agent): the broker announced the call the run parked on (see above).
    if (outcome.status === 'blocked' && outcome.toolCallId) return;
    settle(report(outcome, runSince));
  });
}

/**
 * Renew a kicked-off run's open-run entry until the run ends, like the
 * dispatcher's heartbeat, so no dispatcher starts the role again meanwhile.
 * `endReason` is how that run ended, once it has; `stop` is for a kickoff that fails.
 */
export function heartbeatOpenRunUntilEnd(
  session: RunEndCaptureSession,
  kickoffId: string,
  { sessionId, events }: RunReportSession,
): { endReason: () => RunEndReason; stop: () => void } {
  let endReason: RunEndReason;
  let unsubscribe = () => {};
  const timer = setInterval(
    () => void heartbeatSessionOpenRun(session, kickoffId),
    Math.floor(FACTORY_OPEN_RUN_STALE_MS / 3),
  );
  timer.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
  unsubscribe = events.listen(sessionId, ({ event }) => {
    if (event.type !== 'run.ended') return;
    endReason ??= ledgerRunEndReason(event.reason);
    stop();
  });
  return { endReason: () => endReason, stop };
}

/** `null` for an aborted run: someone stopped or steered it, which is not an outcome. */
export function runOutcome(
  reason: RunEndReason,
  parked: ParkedTool | undefined,
  errorMessage?: string,
): FactoryRunOutcome | null {
  switch (reason) {
    case 'error': {
      const message = errorMessage?.trim();
      return {
        status: 'failed',
        reason: message
          ? `the run ended in error: ${message.slice(0, ERROR_MESSAGE_LENGTH)}`
          : 'the run ended in error.',
      };
    }
    case 'aborted':
      return null;
    case 'suspended':
      return {
        status: 'blocked',
        ...(parked
          ? {
              toolName: parked.toolName,
              toolCallId: parked.toolCallId,
              ...(parked.approval ? { approval: true } : {}),
            }
          : {}),
      };
    default:
      return { status: 'done' };
  }
}
