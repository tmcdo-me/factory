// fork(claude-agent): slice 7h. The parts of a runtime's session that Factory code reads or calls, owned by
// Factory so that code does not name Mastra Code's agent controller types. `@factory/runtime-mastra-code`
// checks at compile time that the controller's own types are assignable to these
// (`session-surface.type-test.ts`); a runtime that cannot supply a field leaves it out.

/** A thread of a session's memory, as Factory reads it. */
export interface RuntimeThread {
  id: string;
  resourceId: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

/** Looking threads up by id or by what they are stamped with. */
export interface RuntimeThreadLookup<T extends RuntimeThread = RuntimeThread> {
  queryThreadById(args: { threadId: string }): Promise<T | null | undefined>;
}

export interface RuntimeThreadQueries<T extends RuntimeThread = RuntimeThread> extends RuntimeThreadLookup<T> {
  queryThreads(args: { resourceId?: string; metadata?: Record<string, unknown> }): Promise<T[]>;
}

/**
 * The events of a live session that Factory code reacts to directly. A session emits more kinds than these;
 * a listener ignores the ones it does not name (the type lists only what Factory reads).
 */
export type RuntimeKnownSessionEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; reason?: 'complete' | 'aborted' | 'error' | 'suspended'; abortReason?: string }
  | { type: 'error'; error: Error }
  | { type: 'om_observation_failed'; cycleId: string; error: string; durationMs: number }
  | { type: 'om_buffering_failed'; cycleId: string; operationType: 'observation' | 'reflection'; error: string }
  | { type: 'tool_suspended'; toolCallId: string; toolName: string; args: unknown; suspendPayload: unknown }
  | { type: 'tool_suspension_cancelled'; toolCallId: string; toolName: string; reason: string }
  | { type: 'thread_changed'; threadId: string; previousThreadId: string | null }
  | { type: 'thread_created'; thread: RuntimeThread }
  | { type: 'thread_deleted'; threadId: string }
  | { type: 'thread_title_updated'; threadId: string; title: string }
  | { type: 'om_thread_title_updated'; cycleId: string; threadId: string; oldTitle?: string; newTitle: string };

/**
 * Any event of a live session. A runtime emits more kinds than {@link RuntimeKnownSessionEvent} names, so a
 * listener narrows with {@link isSessionEvent} and ignores the rest.
 */
export type RuntimeSessionEvent = RuntimeKnownSessionEvent | { type: string };

/** The known event of kind `K`. */
export type RuntimeSessionEventOf<K extends RuntimeKnownSessionEvent['type']> = Extract<
  RuntimeKnownSessionEvent,
  { type: K }
>;

/** Narrows an event to a named kind (the fields of {@link RuntimeKnownSessionEvent}). */
export function isSessionEvent<K extends RuntimeKnownSessionEvent['type']>(
  event: RuntimeSessionEvent,
  type: K,
): event is RuntimeSessionEventOf<K> {
  return event.type === type;
}

/** Something a listener can subscribe to for a session's events; `subscribe` returns the unsubscribe. */
export interface RuntimeSessionEvents {
  subscribe(listener: (event: RuntimeSessionEvent) => void | Promise<void>): () => void;
}

/** A session's state as Factory reads and seeds it: opaque to Factory except these keys. */
export interface RuntimeSessionState extends Record<string, unknown> {
  factoryProjectId?: string;
  factoryOrgId?: string;
  projectRepositoryId?: string;
  untrustedCheckout?: boolean;
  baseRef?: string;
  pluginInstructions?: string[];
}

/** The session state accessors of a live session. */
export interface RuntimeSessionStateAccess<State extends Record<string, unknown> = RuntimeSessionState> {
  get(): State | undefined;
  set(updates: Partial<State>): Promise<void> | void;
}

/** The `controller` entry of a turn's request context: the live session's coordinates and state. */
export interface RuntimeRequestContext<State = unknown> {
  controllerId: string;
  sessionId?: string;
  threadId?: string | null;
  resourceId?: string;
  state: Readonly<State>;
  getState: () => Readonly<State>;
  setState: (updates: Partial<State>) => Promise<void>;
}
