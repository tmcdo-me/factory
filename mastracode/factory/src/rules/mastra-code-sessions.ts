// fork(claude-agent): the dispatcher's questions about Mastra Code sessions, asked through the same
// vocabulary it uses for sessions on another runtime (`FactoryRuntimeSessions`), over the agent controller.
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController } from '@mastra/core/agent-controller';

import type { FactoryRuntimeSessions } from './runtime-sessions.js';

/** What the controller gives the dispatcher: the session registry and the run registry. */
export type MastraCodeController = Pick<AgentController<MastraCodeState>, 'getSession' | 'listActiveThreadRuns'>;

/** The part of `FactoryRuntimeSessions` Mastra Code sessions answer here (kickoff and messages follow in later slices). */
export type MastraCodeSessionQueries = Pick<FactoryRuntimeSessions, 'runs' | 'hasRun' | 'awaitsPerson' | 'abort'>;

/**
 * Mastra Code sessions seen through the seam's vocabulary. Mastra Code keeps its run registry per
 * thread (not per session), so the "is it running" questions are keyed by the thread a binding
 * names, `isThreadRunning` and `anyRunning`, beside the session-keyed ones the seam shares.
 */
export class MastraCodeRuntimeSessions implements MastraCodeSessionQueries {
  readonly #controller: MastraCodeController;

  constructor(controller: MastraCodeController) {
    this.#controller = controller;
  }

  /** Whether the controller holds a live session by this id. Throws when it can't be read. */
  async runs(sessionId: string): Promise<boolean> {
    return (await this.#controller.getSession(sessionId)) !== undefined;
  }

  /** Whether the session's current thread holds a kickoff delivered under this id (its run was started). */
  async hasRun(sessionId: string, runId: string): Promise<boolean> {
    const session = await this.#controller.getSession(sessionId);
    if (!session) return false;
    return (await session.thread.listActiveMessages()).some(message => message.id === runId);
  }

  /** Whether the session waits on a person (a suspended call, a question, a plan to approve). */
  async awaitsPerson(sessionId: string): Promise<boolean> {
    return (await this.#controller.getSession(sessionId))?.suspensions.hasPending() ?? false;
  }

  /**
   * Whether the session, on this very thread, still holds what keeps a binding alive: a call
   * suspended on a person, or a run going. A session that moved to another thread holds neither of
   * this thread's.
   */
  async holdsThread(sessionId: string, threadId: string): Promise<boolean> {
    const session = await this.#controller.getSession(sessionId);
    if (session?.thread.getId() !== threadId) return false;
    return session.suspensions.hasPending() || session.run.isRunning();
  }

  /** Stop the run in flight in the session, if its stream is active. */
  async abort(sessionId: string): Promise<void> {
    const session = await this.#controller.getSession(sessionId);
    if (session?.stream.isActive()) session.abort();
  }

  /** Whether a run is in flight on this thread in this process. */
  isThreadRunning(threadId: string): boolean {
    return this.#controller.listActiveThreadRuns().some(active => active.threadId === threadId);
  }

  /** Whether any run is in flight in this process. */
  anyRunning(): boolean {
    return this.#controller.listActiveThreadRuns().length > 0;
  }
}
