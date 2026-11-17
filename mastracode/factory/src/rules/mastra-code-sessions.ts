// fork(claude-agent): the dispatcher's questions about Mastra Code sessions, asked through the same
// vocabulary it uses for sessions on another runtime (`FactoryRuntimeSessions`), over the agent controller.
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController, Session } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';

import type { FactoryRunBindingRecord } from '../storage/domains/work-items/base.js';
import { FactoryDispatchError, sanitizeDispatchError } from './dispatch-errors.js';
import type { FactoryRuntimeSessions } from './runtime-sessions.js';

export interface FactoryNotificationResult {
  persisted?: Promise<unknown>;
  accepted?: Promise<{
    action?: string;
    output?: { consumeStream(): Promise<unknown> };
  }>;
}

export async function awaitNotification(
  send: () => Promise<FactoryNotificationResult>,
  requireDelivery = false,
): Promise<{ action?: string } | undefined> {
  try {
    const notification = await send();
    const [, accepted] = await Promise.all([notification.persisted, notification.accepted]);
    if (!accepted) {
      if (requireDelivery) {
        throw new FactoryDispatchError(
          'notification_delivery_failed',
          'Factory notification was persisted without agent delivery.',
        );
      }
      return undefined;
    }
    if (!requireDelivery) return accepted;
    if (accepted.action === 'wake') {
      if (!accepted.output) {
        throw new FactoryDispatchError('notification_delivery_failed', 'Factory notification wake had no output.');
      }
      await accepted.output.consumeStream();
      return accepted;
    }
    if (accepted.action !== 'deliver') {
      throw new FactoryDispatchError(
        'notification_delivery_failed',
        `Factory notification did not reach the agent (${String(accepted.action)}).`,
      );
    }
    return accepted;
  } catch (error) {
    if (error instanceof FactoryDispatchError) throw error;
    throw new FactoryDispatchError(
      'notification_delivery_failed',
      `Factory notification delivery failed: ${sanitizeDispatchError(error)}`,
      { cause: error },
    );
  }
}

export function factoryRequestContext(input: {
  session: Session<MastraCodeState>;
  binding: Pick<FactoryRunBindingRecord, 'sessionId' | 'threadId' | 'resourceId'>;
  userId: string;
  orgId: string;
}): RequestContext {
  const { session, binding, userId, orgId } = input;
  const requestContext = new RequestContext();
  requestContext.set('user', { workosId: userId, organizationId: orgId });
  requestContext.set('controller', {
    state: session.state.get(),
    getState: () => session.state.get(),
    sessionId: binding.sessionId,
    threadId: binding.threadId,
    resourceId: binding.resourceId,
    session: {
      id: session.identity.getId(),
      ownerId: session.identity.getOwnerId(),
      modelId: session.model.get() ?? '',
    },
    workspace: session.getWorkspace(),
  });
  return requestContext;
}

/** What the controller gives the dispatcher: the session registry and the run registry. */
export type MastraCodeController = Pick<AgentController<MastraCodeState>, 'getSession' | 'listActiveThreadRuns'>;

/** The part of `FactoryRuntimeSessions` Mastra Code sessions answer here (kickoff and messages follow in later slices). */
export type MastraCodeSessionQueries = Pick<
  FactoryRuntimeSessions,
  'runs' | 'hasRun' | 'awaitsPerson' | 'abort' | 'message'
>;

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

  /**
   * Tell the session something from Factory, as a notification in Mastra Code's inbox: delivered to
   * the run in flight, or (with `wake`) waking the session, whose turn is consumed; otherwise kept
   * for its next turn. The session is moved to the message's thread first. Resolves with no run
   * (Mastra Code's turns are watched through its events). Rejects with a `FactoryDispatchError`:
   * `session_unavailable` when there is no such session, `notification_delivery_failed` otherwise.
   */
  async message(
    sessionId: string,
    message: Parameters<FactoryRuntimeSessions['message']>[1],
    requestContext: RequestContext,
  ): Promise<{ runId?: string; duplicate?: boolean }> {
    const session = await this.#controller.getSession(sessionId);
    if (!session) throw new FactoryDispatchError('session_unavailable', 'Bound Factory session not found.');
    const thread = message.thread ?? {
      id: session.thread.requireId(),
      resourceId: session.identity.getResourceId(),
    };
    const owner = requestContext.get('user') as { workosId: string; organizationId: string } | undefined;
    const contextFor = () =>
      factoryRequestContext({
        session,
        binding: { sessionId, threadId: thread.id, resourceId: thread.resourceId },
        userId: owner?.workosId ?? '',
        orgId: owner?.organizationId ?? '',
      });
    // Switching subscribes to the thread, which resolves memory and model credentials: as the owner.
    if (session.thread.requireId() !== thread.id) {
      await session.thread.switch({ threadId: thread.id, requestContext: contextFor() });
    }
    const sendContext = contextFor();
    await awaitNotification(
      () =>
        session.sendNotificationSignal(
          {
            source: 'factory',
            kind: message.source,
            summary: message.text,
            priority: message.priority ?? 'high',
            payload: { message: message.text },
            ...(message.sourceId !== undefined ? { sourceId: message.sourceId } : {}),
            ...(message.idempotencyKey !== undefined ? { dedupeKey: message.idempotencyKey } : {}),
          },
          {
            ifActive: { behavior: 'deliver' },
            ifIdle: { behavior: message.wake ? 'wake' : 'persist' },
            requestContext: sendContext,
          },
        ),
      true,
    );
    return {};
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
