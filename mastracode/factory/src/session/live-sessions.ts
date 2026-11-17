import { isSessionEvent } from '@factory/agent-runtime';
import type { RuntimeSessionEvents } from '@factory/agent-runtime';
import type { PubSub } from '@mastra/core/events';

import { touchFeed } from '../feed-events.js';
import type { SourceControlSession } from '../storage/domains/source-control/base.js';
import type { ParkedInteraction } from './parked-interaction.js'; // fork(claude-agent)

/** The slice of a live session this registry needs: its id, its run, and who it works for. */
export interface LiveSession extends RuntimeSessionEvents {
  readonly identity: { getId(): string };
  readonly run: { isRunning(): boolean };
  readonly state: { get(): Readonly<{ factoryOrgId?: string; factoryProjectId?: string }> };
}

export interface SessionNotifier {
  onSessionCreated(listener: (session: LiveSession) => void): () => void;
  onSessionDeleted(listener: (session: LiveSession) => void): () => void;
}

/** Where a session's Factory is written down for good: its live state can lose it, its row cannot. */
export interface SessionRows {
  getBySessionId(sessionId: string): Promise<Pick<SourceControlSession, 'orgId' | 'factoryProjectId'> | null>;
}

/** The tool a session has waited on longest, and since when (epoch ms). */
export interface ParkedRun {
  toolName: string;
  suspendedAt: number;
  /** fork(claude-agent): what the call asks, when a person can answer it from outside the session. */
  interaction?: ParkedInteraction;
}

/**
 * fork(claude-agent): where parked sessions are read: the interaction broker's index, which holds
 * what every session waits on a person for, whatever its runtime (`PendingInteractions`).
 */
export interface ParkedRunSource {
  parked(sessionId: string): ParkedRun | undefined;
  parkedIn(factoryProjectId: string): Array<{ sessionId: string; run: ParkedRun }>;
}

interface TrackedSession {
  session: LiveSession;
  unsubscribe: () => void;
}

/**
 * Events after which the controller may list different runs for a session, beyond the parking ones.
 * Leaving a thread drops the run the session started on it, and no `agent_end` reaches a session that has left.
 */
const RUN_MAY_HAVE_CHANGED = new Set<string>(['agent_start', 'thread_changed', 'thread_created', 'thread_deleted']);

/**
 * The sessions this process has materialized, by session id.
 *
 * Membership comes from the controller's notifications rather than
 * `getSession`, which hands back the pending creation — awaiting it
 * from a request blocks for as long as the session takes to materialize its
 * sandbox, minutes on a cold clone. Notifications only fire once a session
 * exists, so a read never waits.
 *
 * Whether a session is *running* is read from the session itself, never
 * tracked here: no missed run event can leave the answer stuck.
 *
 * fork(claude-agent): whether it is *parked* (waits on a person) is read from the
 * interaction broker's index (`addParkedSource`), which records what each
 * session waits on, whatever its runtime: a Mastra Code session's paused calls
 * as its controller reports them. Upstream read the controller's display state.
 */
export class LiveSessions {
  readonly #byId = new Map<string, TrackedSession>();
  readonly #runListeners = new Set<(session: LiveSession) => void>();
  /** fork(claude-agent): where parked sessions are read. */
  readonly #parkedSources: ParkedRunSource[] = [];

  constructor(controller: SessionNotifier) {
    controller.onSessionCreated(session => this.#track(session));
    controller.onSessionDeleted(session => {
      const id = session.identity.getId();
      this.#byId.get(id)?.unsubscribe();
      this.#byId.delete(id);
      // The controller resets the run before it reports the deletion, so the session can no longer say a board showed it.
      for (const listener of this.#runListeners) listener(session);
    });
  }

  #track(session: LiveSession): void {
    const unsubscribe = session.subscribe(event => {
      const parkMayHaveChanged =
        isSessionEvent(event, 'tool_suspended') ||
        isSessionEvent(event, 'tool_suspension_cancelled') ||
        (isSessionEvent(event, 'agent_end') && event.reason !== 'suspended');
      if (!parkMayHaveChanged && !RUN_MAY_HAVE_CHANGED.has(event.type)) return;
      for (const listener of this.#runListeners) listener(session);
    });
    this.#byId.set(session.identity.getId(), { session, unsubscribe });
  }

  /** Whether the session has an agent run in flight right now. */
  isRunning(sessionId: string): boolean {
    return this.#byId.get(sessionId)?.session.run.isRunning() ?? false;
  }

  /** fork(claude-agent): report the sessions `source` says are parked. */
  addParkedSource(source: ParkedRunSource): void {
    this.#parkedSources.push(source);
  }

  /** The tool the session is parked on, oldest first, or nothing when no answer is owed. */
  parked(sessionId: string): ParkedRun | undefined {
    // fork(claude-agent): read from the interaction broker's index, for every runtime.
    for (const source of this.#parkedSources) {
      const run = source.parked(sessionId);
      if (run) return run;
    }
    return undefined;
  }

  /** Every parked session of a project, so the inbox reads no card when nothing waits. */
  parkedIn(factoryProjectId: string): Array<{ sessionId: string; run: ParkedRun }> {
    const parked: Array<{ sessionId: string; run: ParkedRun }> = [];
    // fork(claude-agent): read from the interaction broker's index, for every runtime.
    for (const source of this.#parkedSources) {
      for (const entry of source.parkedIn(factoryProjectId)) {
        if (!parked.some(known => known.sessionId === entry.sessionId)) parked.push(entry);
      }
    }
    return parked;
  }

  /** Fires when a session starts a run, parks, is answered, finishes a turn, or leaves its thread: whoever shows runs re-reads. */
  onRunChanged(listener: (session: LiveSession) => void): () => void {
    this.#runListeners.add(listener);
    return () => this.#runListeners.delete(listener);
  }
}

/** A run starting, parking, being answered or ending changes what boards show, so the registry bumps the project's feed. */
export function liveSessionsTouchingTheFeed(
  controller: SessionNotifier,
  eventBus: PubSub,
  rows: SessionRows,
): LiveSessions {
  const liveSessions = new LiveSessions(controller);
  liveSessions.onRunChanged(session => {
    const { factoryOrgId, factoryProjectId } = session.state.get();
    if (factoryOrgId && factoryProjectId) {
      touchFeed(eventBus, { orgId: factoryOrgId, factoryProjectId });
      return;
    }
    // Only a Factory run carries its project in state, and a recovered one can come back without it: its row names it.
    rows
      .getBySessionId(session.identity.getId())
      .then(row => {
        if (row?.factoryProjectId) touchFeed(eventBus, { orgId: row.orgId, factoryProjectId: row.factoryProjectId });
      })
      .catch(error => console.warn('[factory] Unable to find the board of a session run.', error));
  });
  return liveSessions;
}
