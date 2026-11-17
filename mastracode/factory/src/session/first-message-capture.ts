import type { EventEnvelope } from '@factory/agent-runtime';

import type { SourceControlStorageHandle } from '../storage/domains/source-control/base.js';

export interface FirstMessageCaptureSession {
  readonly identity: { getId(): string };
}

export interface FirstMessageCaptureDependencies {
  /** fork(claude-agent): slice 7. The session's events are heard on Factory's event hub. */
  events: { listen(sessionId: string, listener: (envelope: EventEnvelope) => void): () => void };
  sourceControl: {
    sessions: Pick<SourceControlStorageHandle['sessions'], 'markFirstMessage'>;
  };
}

/**
 * Record when a session's agent first produced an actual conversational
 * message (the TTFI anchor — "time to first interaction").
 *
 * We stamp on the first `message.started` that is not a signal (a user's text delivered as a runtime
 * signal carries `signal: true`). The coordinator writes `role='signal'` rows into the thread (skill loads,
 * phase markers, memory reminders) before the model is ever invoked; those
 * signals used to trigger a stamp via `agent_start`, giving every session —
 * including zero-message model-init failures — a false TTFI of a few seconds.
 * Gating on real conversational roles keeps the TTFI column honest: sessions
 * that never produced a user or assistant message stay NULL and drop out of
 * TTFI percentiles instead of contaminating them.
 *
 * The listener unsubscribes after the first qualifying message; the storage
 * write is guarded (`first_message_at IS NULL`), so restarts, re-materialized
 * sessions, and sessions without a source-control row (chat-only channels)
 * are no-ops.
 */
export function observeSessionFirstMessage(
  session: FirstMessageCaptureSession,
  { sourceControl, events }: FirstMessageCaptureDependencies,
): () => void {
  let seen = false;
  const unsubscribe = events.listen(session.identity.getId(), ({ event }) => {
    if (seen || event.type !== 'message.started' || event.signal) return;
    seen = true;
    unsubscribe();
    void sourceControl.sessions
      .markFirstMessage({ sessionId: session.identity.getId() })
      .catch(error => console.warn('[Factory first-message capture] Unable to persist first message time.', error));
  });
  return unsubscribe;
}
