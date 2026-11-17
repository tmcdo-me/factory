// fork(claude-agent): what sessions wait on a person for, kept in the interaction broker for both runtimes.
import type { InteractionRecord, InteractionRequest, InteractionStore } from '@factory/agent-runtime';

import type { FactoryRunOutcome } from '../tools/reports.js';
import type { LiveSessions, ParkedRun, ParkedRunSource } from './live-sessions.js';
import { brokerInteraction } from './parked-interaction.js';

/** The Factory project a session works in. */
export interface SessionProject {
  orgId: string;
  factoryProjectId: string;
}

export interface PendingInteractionsOptions {
  /** Where the interaction broker keeps its records. */
  store: InteractionStore;
  /** The project a session belongs to (its source-control row), or none for a session outside any. */
  projectOf(sessionId: string): Promise<{ orgId: string; factoryProjectId?: string | null } | null | undefined>;
  /** Told whenever a session in a project starts or stops waiting on a person: boards and the inbox re-read. */
  onChanged?(sessionId: string, project: SessionProject): void;
  /** Told when a session asks a person something, as it asks (not for the ones loaded at start). */
  onRequested?(record: InteractionRecord, project: SessionProject): void;
}

/** The tool a request came from, as a Mastra Code session's parked tool is named. */
export function interactionToolName(request: InteractionRequest): string {
  if (request.kind === 'plan_approval') return 'submit_plan';
  if (request.kind === 'question') return 'ask_user';
  return request.toolName;
}

/**
 * Whether the interaction is one a runtime holds itself (Mastra Code's controller). Slice 5a keeps
 * those in the index, so an answer and the runtime's own word settle the same record, but readers
 * still read such sessions from the runtime until slice 5b moves them here.
 */
const heldByRuntime = (record: InteractionRecord) => record.heldBy !== undefined;

/** Whether a yes or no is all the request needs (`factory_answer_approval` can give it). */
export function answersWithDecision(request: InteractionRequest): boolean {
  return request.kind === 'plan_approval' || request.kind === 'tool_approval';
}

/**
 * The `blocked` report a session's followers get when it starts waiting on a person, as they get one
 * when a Mastra Code run parks: it names the call, so a yes or no can come from
 * `factory_answer_approval` or the notice's buttons. A Claude Agent session's thread is its own id.
 */
export function waitingReport(record: InteractionRecord): {
  sessionId: string;
  threadId: string;
  since: Date;
  outcome: FactoryRunOutcome;
} {
  return {
    sessionId: record.sessionId,
    threadId: record.sessionId,
    since: new Date(record.requestedAt),
    outcome: {
      status: 'blocked',
      toolName: interactionToolName(record.request),
      ...(record.callId ? { toolCallId: record.callId } : {}),
      ...(answersWithDecision(record.request) ? { decision: true } : {}),
    },
  };
}

interface Waiting {
  record: InteractionRecord;
  /** When the session started waiting (its stored `requestedAt`): it doubles as the inbox receipt key. */
  stamp: number;
  /** Its runtime let go of it and its outcome is on its way: indexed, not listed. */
  hidden?: boolean;
}

/**
 * The broker's store, plus an index of what each session waits on, so the inbox, boards and
 * session lists read Claude Agent sessions parked on a person the way they read a suspended Mastra
 * Code run: synchronously, from memory. Every record passes through here, so the index follows
 * every request and every answer or cancellation; `load` picks up the ones still pending from
 * before a restart (an answer to those reaches the conversation as a message).
 *
 * Mastra Code's waiting calls are recorded here too, held by its controller (`heldBy`), which takes
 * their answers; `waitingOn` finds them by call as the controller reports them settled.
 */
export class PendingInteractions implements InteractionStore, ParkedRunSource {
  readonly #options: PendingInteractionsOptions;
  /** Pending interactions by session, then by id. */
  readonly #waiting = new Map<string, Map<string, Waiting>>();
  /** Each waiting session's project, once known. */
  readonly #projects = new Map<string, SessionProject | null>();
  #lastStamp = 0;

  constructor(options: PendingInteractionsOptions) {
    this.#options = options;
  }

  /**
   * Read what was still pending when the server last stopped. Each record is read again before it
   * is indexed: one answered or cancelled while the list was read is not shown as waiting.
   */
  async load(): Promise<void> {
    for (const listed of await this.#options.store.listPending()) {
      // Nothing is awaited between this read and indexing it, so a later answer always finds it.
      const record = await this.#options.store.get(listed.id);
      if (record?.status !== 'pending') continue;
      this.#lastStamp = Math.max(this.#lastStamp, this.#stampOf(record));
      this.#add(record, false);
    }
  }

  /**
   * Store a new request. Its `requestedAt` is moved on by a millisecond when another request took
   * that one in this process, so each wait has its own receipt key, and the stored time keeps that
   * key the same across a restart.
   */
  async create(record: InteractionRecord): Promise<void> {
    const at = Date.parse(record.requestedAt);
    this.#lastStamp = Math.max(Number.isFinite(at) ? at : Date.now(), this.#lastStamp + 1);
    record.requestedAt = new Date(this.#lastStamp).toISOString();
    await this.#options.store.create(record);
    if (record.status === 'pending') this.#add(record, true);
  }

  get(id: string): Promise<InteractionRecord | undefined> {
    return this.#options.store.get(id);
  }

  async settle(
    id: string,
    settlement: Parameters<InteractionStore['settle']>[1],
  ): Promise<InteractionRecord | undefined> {
    const record = await this.#options.store.settle(id, settlement);
    if (record) this.#remove(record);
    return record;
  }

  listPending(filter?: { sessionId?: string }): Promise<InteractionRecord[]> {
    return this.#options.store.listPending(filter);
  }

  /**
   * A pending record the broker found stored when a runtime reported it waiting again: indexed if it
   * wasn't, and listed again if it was hidden.
   */
  adopt(record: InteractionRecord): void {
    if (record.status !== 'pending') return;
    const waiting = this.#waiting.get(record.sessionId)?.get(record.id);
    if (!waiting) {
      this.#add(record, false);
      return;
    }
    if (!waiting.hidden) return;
    waiting.hidden = false;
    this.#changed(record.sessionId);
  }

  /**
   * Stop listing what a session holds for one tool call while its outcome is on its way (its runtime
   * let go of it, an answer reached the tool): it stays indexed until it settles, or comes back.
   */
  hide(sessionId: string, callId: string): void {
    let hid = false;
    for (const waiting of this.#waiting.get(sessionId)?.values() ?? []) {
      if (waiting.record.callId !== callId || waiting.hidden) continue;
      waiting.hidden = true;
      hid = true;
    }
    if (hid) this.#changed(sessionId);
  }

  #changed(sessionId: string): void {
    const project = this.#projects.get(sessionId);
    if (project) this.#notify(() => this.#options.onChanged?.(sessionId, project));
  }

  /** The pending interactions a session holds for one tool call, from memory. */
  waitingOn(sessionId: string, callId: string): InteractionRecord[] {
    return [...(this.#waiting.get(sessionId)?.values() ?? [])]
      .filter(waiting => waiting.record.callId === callId)
      .map(waiting => waiting.record);
  }

  /** What the session has waited on longest, or nothing. */
  parked(sessionId: string): ParkedRun | undefined {
    let oldest: Waiting | undefined;
    for (const waiting of this.#waiting.get(sessionId)?.values() ?? []) {
      if (waiting.hidden) continue;
      if (heldByRuntime(waiting.record)) continue; // read from the runtime until slice 5b
      if (!oldest || waiting.stamp < oldest.stamp) oldest = waiting;
    }
    if (!oldest) return undefined;
    const interaction = brokerInteraction(oldest.record);
    return {
      toolName: interactionToolName(oldest.record.request),
      suspendedAt: oldest.stamp,
      ...(interaction ? { interaction } : {}),
    };
  }

  parkedIn(factoryProjectId: string): Array<{ sessionId: string; run: ParkedRun }> {
    const parked: Array<{ sessionId: string; run: ParkedRun }> = [];
    for (const sessionId of this.#waiting.keys()) {
      if (this.#projects.get(sessionId)?.factoryProjectId !== factoryProjectId) continue;
      const run = this.parked(sessionId);
      if (run) parked.push({ sessionId, run });
    }
    return parked;
  }

  #stampOf(record: InteractionRecord): number {
    const at = Date.parse(record.requestedAt);
    return Number.isFinite(at) ? at : 0;
  }

  #add(record: InteractionRecord, announce: boolean): void {
    const waiting = this.#waiting.get(record.sessionId) ?? new Map<string, Waiting>();
    waiting.set(record.id, { record, stamp: this.#stampOf(record) });
    this.#waiting.set(record.sessionId, waiting);
    void this.#project(record.sessionId).then(project => {
      if (!project || !this.#waiting.get(record.sessionId)?.has(record.id)) return;
      this.#notify(() => this.#options.onChanged?.(record.sessionId, project));
      // A runtime that holds its calls tells followers itself, until slice 5d.
      if (announce && !heldByRuntime(record)) this.#notify(() => this.#options.onRequested?.(record, project));
    });
  }

  #remove(record: InteractionRecord): void {
    const waiting = this.#waiting.get(record.sessionId);
    if (!waiting?.delete(record.id)) return;
    if (waiting.size === 0) this.#waiting.delete(record.sessionId);
    const project = this.#projects.get(record.sessionId);
    if (!this.#waiting.has(record.sessionId)) this.#projects.delete(record.sessionId);
    if (project) this.#notify(() => this.#options.onChanged?.(record.sessionId, project));
  }

  /** The session's project, read once while it waits. A failed read is retried with its next request. */
  async #project(sessionId: string): Promise<SessionProject | null> {
    if (this.#projects.has(sessionId)) return this.#projects.get(sessionId) ?? null;
    try {
      const found = await this.#options.projectOf(sessionId);
      const project = found?.factoryProjectId ? { orgId: found.orgId, factoryProjectId: found.factoryProjectId } : null;
      // Only while it still waits: a session answered meanwhile is forgotten.
      if (this.#waiting.has(sessionId)) this.#projects.set(sessionId, project);
      return project;
    } catch (error) {
      console.warn(`[factory] Unable to find the project of session ${sessionId}, which waits on a person.`, error);
      return null;
    }
  }

  #notify(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      console.warn('[factory] A pending-interaction listener failed.', error);
    }
  }
}

/** `sessions`, also reporting the sessions `source` says are parked. */
export function alsoParked(sessions: LiveSessions, source: ParkedRunSource): LiveSessions {
  sessions.addParkedSource(source);
  return sessions;
}
