// fork(claude-agent): slice 7j. The `controller` entry of a turn's request context as Factory's context providers
// and processor read it, owned by Factory. `runtime-mastra-code/src/turn-controller.test.ts` checks at compile
// time that the controller's own request context is assignable to it.

/** What a turn's request context carries about its session, for the code that reads it directly. */
export interface RuntimeTurnController {
  /** The session's state: opaque except for the keys the caller reads. */
  state?: Readonly<Record<string, unknown>>;
  /** The runtime's session record, when the controller carries one. */
  session?: { modelId: string; modeId?: string };
  /** Reports an error event to the session's observers (a run keeps going). */
  emitEvent?(event: { type: 'error'; error: Error; errorType?: string; retryable?: boolean }): void;
}
