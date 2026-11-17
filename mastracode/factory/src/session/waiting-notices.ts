// fork(claude-agent): what a session's followers are told as it starts waiting on a person, for both runtimes.
import type { InteractionRecord } from '@factory/agent-runtime';

import type { FactoryApprovalNotifier, FactorySessionRunEndReporter } from '../tools/reports.js';
import { waitingReport } from './pending-interactions.js';

/** How many of a session's run windows are remembered: a call is announced a moment after it starts waiting. */
const WINDOWS_KEPT = 4;

/**
 * Where each Mastra Code session's run windows opened (`observeSessionRunReports`), and the thread it
 * runs on, so a call announced from the interaction broker is judged on the run that asked it: an
 * agent's own `blocked` report in that run still stands in for the notice, as it did when the notice
 * was the run's end report. The window moves at that run's end, which can come before the broker
 * has the call, so a call is matched to the window open when it started waiting.
 */
export class SessionReportWindows {
  readonly #sessions = new Map<
    string,
    { threadId: () => string | null | undefined; opened: Array<{ since: Date; threadId: string | null }> }
  >();

  /**
   * Follow a session's windows; `threadId` reads the thread it runs on now, or `undefined` once the
   * session is gone (so it should not be held on to: the entry is dropped the next time one is added).
   */
  watch(sessionId: string, threadId: () => string | null | undefined): (since: Date) => void {
    for (const [id, gone] of this.#sessions)
      if (id !== sessionId && gone.threadId() === undefined) this.#sessions.delete(id);
    const entry = { threadId, opened: [] as Array<{ since: Date; threadId: string | null }> };
    this.#sessions.set(sessionId, entry);
    return since => {
      // The thread is read as the window opens: a call is named by the thread it started waiting on,
      // not the one the session has moved to by the time it is announced.
      entry.opened.push({ since, threadId: threadId() ?? null });
      if (entry.opened.length > WINDOWS_KEPT) entry.opened.shift();
    };
  }

  /** The thread and the run window `sessionId` was in at `moment`, if it is followed. */
  at(sessionId: string, moment: Date): { threadId: string | null; since: Date } | undefined {
    const entry = this.#sessions.get(sessionId);
    const current = entry?.threadId();
    if (!entry || current === undefined) return undefined;
    // Never a window opened after the moment: one older than any kept is judged from the moment itself.
    const window = entry.opened.findLast(opened => opened.since.getTime() <= moment.getTime());
    return { threadId: window ? window.threadId : current, since: window?.since ?? moment };
  }
}

/**
 * Tell a session's followers it waits on a person, as the interaction broker records the wait. A
 * Claude Agent session's wait is a `blocked` report from the moment it asked (its thread is its
 * own id). A Mastra Code session's call (held by its controller) is a gate's urgent `approval`
 * notice, or a `blocked` report for anything else (a plan, a question, a tool that paused itself),
 * on the run window the call started in; nothing is said for a call the board answers itself.
 */
export function createWaitingNotices({
  reportRunEnd,
  notifyApproval,
  windows,
  answersItself,
}: {
  reportRunEnd: FactorySessionRunEndReporter;
  notifyApproval: FactoryApprovalNotifier;
  windows: SessionReportWindows;
  /** Whether the Factory answers the paused call itself (a phase that approves its own exit tool). */
  answersItself: (toolCallId: string) => boolean;
}): (record: InteractionRecord) => Promise<void> {
  return async record => {
    if (!record.heldBy) {
      await reportRunEnd(waitingReport(record));
      return;
    }
    const toolCallId = record.callId;
    if (!toolCallId || answersItself(toolCallId)) return;
    const requestedAt = new Date(record.requestedAt);
    const run = windows.at(record.sessionId, requestedAt);
    // A session whose runs aren't followed here is named by its first thread, its own id.
    const threadId = run?.threadId ?? record.sessionId;
    const { request } = record;
    if (request.kind === 'tool_approval' && request.gate) {
      await notifyApproval({
        sessionId: record.sessionId,
        threadId,
        toolName: request.toolName,
        toolCallId,
        args: request.input,
      });
      return;
    }
    await reportRunEnd({
      sessionId: record.sessionId,
      threadId,
      since: run?.since ?? requestedAt,
      outcome: waitingReport(record).outcome,
    });
  };
}
