// fork(claude-agent): the dispatcher's questions about Mastra Code sessions, asked through the same
// vocabulary it uses for sessions on another runtime (`FactoryRuntimeSessions`), over the agent controller.
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController, Session } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';

import { resolvePromptInvocation, resolveSkillInvocation, resolveSkillResumeInvocation } from '../skills/service.js';
import type { FactoryRunBindingRecord } from '../storage/domains/work-items/base.js';
import { withWorkItemDescription } from '../work-items/description-context.js';
import { FactoryDispatchError, sanitizeDispatchError } from './dispatch-errors.js';
import type { FactoryRuntimeSessions, RuntimeRunEnd } from './runtime-sessions.js';
import { FactoryDecisionSuperseded, watchRun } from './watch-run.js';
import type { ApprovePausedCall } from './watch-run.js';

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
  'runs' | 'hasRun' | 'awaitsPerson' | 'abort' | 'message' | 'kickoff' | 'ownsGoal'
>;

/** What the dispatcher lends the adapter to watch a kickoff's run: its observation timeout and how it approves a paused call. */
export interface MastraCodeKickoffOptions {
  timeoutMs: number;
  /** Where a run says which paused calls it is about to answer itself. */
  autoApproving: Set<string>;
  approver(sessionId: string, requestContext: RequestContext, label: string): ApprovePausedCall | undefined;
}

const SKILL_RUN_LABEL = 'Factory skill run';

/**
 * Mastra Code sessions seen through the seam's vocabulary. Mastra Code keeps its run registry per
 * thread (not per session), so the "is it running" questions are keyed by the thread a binding
 * names, `isThreadRunning` and `anyRunning`, beside the session-keyed ones the seam shares.
 */
export class MastraCodeRuntimeSessions implements MastraCodeSessionQueries {
  /** Mastra Code keeps its objective loop: it re-kicks inside one run and judges its goal itself. */
  readonly ownsGoal = true;
  readonly #controller: MastraCodeController;
  readonly #kickoffOptions?: MastraCodeKickoffOptions;

  constructor(controller: MastraCodeController, kickoffOptions?: MastraCodeKickoffOptions) {
    this.#controller = controller;
    this.#kickoffOptions = kickoffOptions;
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
    // Built after the switch for the send: the session's state is read as the thread it moved to.
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

  /**
   * Start a board run: the kickoff as a typed `skill` signal (a plain prompt as a user message), with
   * the card's description appended and a rule's preface said first. Resolves once the kickoff reached
   * the agent (delivered onto a run in flight, or waking one); a delivery that may not have landed is
   * followed to the end of the run it was queued onto and sent again while it is still wanted.
   * Failures are the adapter's raw ones (`FactoryDispatchError` for a delivery that could not be
   * confirmed). `ended` never rejects: it resolves with the run's verdict in `failure` (an error that
   * ended it, `run_overdue`, `run_terminal_event_missing`, `run_configuration_invalid`), or as
   * `awaiting_interaction` for a run suspended on a person.
   */
  async kickoff(
    sessionId: string,
    kickoff: Parameters<FactoryRuntimeSessions['kickoff']>[1],
    requestContext: RequestContext,
  ): Promise<{
    ended: Promise<RuntimeRunEnd>;
    observedEnd: () => 'complete' | 'aborted' | 'error' | 'suspended' | undefined;
    close: () => void;
  }> {
    const options = this.#kickoffOptions;
    if (!options) throw new Error('Mastra Code kickoffs are not configured.');
    const session = await this.#controller.getSession(sessionId);
    if (!session) throw new FactoryDispatchError('session_unavailable', 'Bound Factory session not found.');
    const thread = kickoff.thread ?? { id: session.thread.requireId(), resourceId: session.identity.getResourceId() };
    const owner = requestContext.get('user') as { workosId: string; organizationId: string } | undefined;
    const contextFor = () =>
      factoryRequestContext({
        session,
        binding: { sessionId, threadId: thread.id, resourceId: thread.resourceId },
        userId: owner?.workosId ?? '',
        orgId: owner?.organizationId ?? '',
      });
    const resolved =
      kickoff.skill === undefined
        ? await resolvePromptInvocation(this.#controller, { sessionId, prompt: kickoff.prompt ?? '' })
        : kickoff.skill.resume === true
          ? await resolveSkillResumeInvocation(this.#controller, {
              sessionId,
              name: kickoff.skill.name,
              arguments: kickoff.skill.arguments,
            })
          : await resolveSkillInvocation(this.#controller, {
              sessionId,
              name: kickoff.skill.name,
              arguments: kickoff.skill.arguments,
            });
    if (session.thread.requireId() !== thread.id) {
      await session.thread.switch({ threadId: thread.id, requestContext: contextFor() });
    }
    const sendContext = contextFor();
    const deliveryId = kickoff.runId;
    const landed = () => this.hasRun(sessionId, deliveryId);
    const stale = async () => (kickoff.stillWanted ? !(await kickoff.stillWanted()) : false);
    // Safe under the caller's replay guard: it matches the delivery id, never the prompt's content.
    const contents = withWorkItemDescription(resolved.contents, kickoff.description);
    // A skill kickoff is system-generated, not something the human typed: send it as a typed `skill`
    // signal so the model sees `<skill name="…">` and traces record the skill name.
    const signal =
      resolved.skillName !== undefined
        ? { type: 'reactive' as const, tagName: 'skill', attributes: { name: resolved.skillName } }
        : { type: 'user' as const, tagName: 'user' };
    if (kickoff.cancelInFlight) await this.abort(sessionId);
    const preface = kickoff.preface;
    if (preface) {
      await awaitNotification(() =>
        session.sendNotificationSignal(
          {
            source: 'factory',
            kind: 'stage-transition',
            summary: preface,
            priority: 'medium',
            payload: { message: preface },
            ...(kickoff.prefaceKeys
              ? { sourceId: kickoff.prefaceKeys.sourceId, dedupeKey: kickoff.prefaceKeys.dedupeKey }
              : {}),
          },
          { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'persist' }, requestContext: sendContext },
        ),
      );
      if (await stale()) throw new FactoryDecisionSuperseded();
    }
    const run = watchRun(session, {
      timeoutMs: options.timeoutMs,
      autoApprovedTool: kickoff.autoApprovedTool,
      autoApproving: options.autoApproving,
      approve: options.approver(sessionId, sendContext, SKILL_RUN_LABEL),
      onAgentEnd: kickoff.superseded,
      label: SKILL_RUN_LABEL,
      runStillActive: () => this.isThreadRunning(thread.id),
    });
    const sendKickoff = async () => {
      const result = session.sendSignal(
        { id: deliveryId, ...signal, contents },
        // Without `requireDelivery` the session resolves `accepted` on the next tick and swallows wake
        // failures, so a kickoff that never reached the agent would be marked succeeded.
        { requestContext: sendContext, requireDelivery: true },
      );
      const settled = await result.accepted;
      if (settled.action !== 'wake' && settled.action !== 'deliver') {
        // A named non-delivery action proves no run began and is safe to retry. An absent action did
        // not confirm either outcome, so a new delivery generation could duplicate work.
        throw new FactoryDispatchError(
          settled.action ? 'notification_delivery_failed' : 'skill_delivery_ambiguous',
          `Factory skill invocation signal did not reach the agent (${String(settled.action)}).`,
        );
      }
      return settled;
    };
    try {
      let settled = await sendKickoff();
      while (settled.action === 'deliver') {
        // `deliver` means the signal was queued onto a run already in flight. If that run ends before
        // draining its queue the prompt is dropped silently, so confirm the message landed in the
        // thread rather than trusting the ack.
        if (await landed()) break;
        // Another run can start while the previous one is finishing: follow each run boundary until the
        // kickoff either lands on an active run or wakes a new one.
        if (!(await run.wait())) {
          throw new FactoryDispatchError(
            'run_terminal_event_missing',
            'Factory skill invocation is waiting on a run whose terminal event was not observed.',
          );
        }
        // The queued copy often surfaces only once the run it was queued onto ends. Resend only when it
        // is still missing, and never once the card has moved on or the seat was handed over.
        if (await landed()) break;
        if (await stale()) throw new FactoryDecisionSuperseded();
        run.arm();
        settled = await sendKickoff();
      }
      await kickoff.delivered?.();
    } catch (error) {
      run.close();
      throw error;
    }
    const ended = (async (): Promise<RuntimeRunEnd> => {
      try {
        await run.settle();
        return {
          reason: run.endReason() === 'suspended' ? 'awaiting_interaction' : 'complete',
          supersededAtEnd: run.supersededAtEnd(),
        };
      } catch (error) {
        return {
          reason: run.endReason() === 'aborted' ? 'aborted' : 'error',
          error: error instanceof Error ? error.message : String(error),
          failure: error instanceof Error ? error : new Error(String(error)),
          supersededAtEnd: run.supersededAtEnd(),
        };
      } finally {
        run.close();
      }
    })();
    return { ended, observedEnd: run.endReason, close: run.close };
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
