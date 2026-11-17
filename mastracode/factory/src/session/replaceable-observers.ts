// fork(claude-agent): slice 6. Observers on the process-wide event hub, kept per session id.

/**
 * The event hub's listeners are keyed by session id and outlive the session object, so a session
 * created again under an id (a resume) must replace the previous one's observers, not add to them:
 * otherwise each run end is reported and audited twice and the dead session stays in memory.
 */
export function createReplaceableObservers() {
  const stops = new Map<string, Array<() => void>>();
  const stopAll = (sessionId: string) => {
    for (const stop of stops.get(sessionId) ?? []) stop();
    stops.delete(sessionId);
  };
  return {
    /** Stop the observers kept for `sessionId` (also what a close hook calls). */
    release: stopAll,
    /** Keep `observers` for `sessionId`, stopping any kept before. */
    replace(sessionId: string, observers: Array<() => void>): void {
      stopAll(sessionId);
      stops.set(sessionId, observers);
    },
  };
}
