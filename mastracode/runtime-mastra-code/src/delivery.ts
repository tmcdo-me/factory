import type { RuntimeLiveSession } from '@factory/agent-runtime';
import type { AgentController } from '@mastra/core/agent-controller';
import type { SendNotificationSignalInput } from '@mastra/core/notifications';

/**
 * The slice of Mastra Code's controller Factory's messaging uses: the stored threads a message is
 * addressed to, the live sessions it reaches, and the session's model (side sessions).
 */
export type MastraCodeDeliveryController = Pick<
  AgentController<any>,
  | 'queryThreadById'
  | 'queryThreads'
  | 'setThreadModel'
  | 'listAvailableModels'
  | 'getSession'
  | 'createSession'
  | 'getCurrentAgent'
>;

/** A live Mastra Code session, as the controller hands it out. */
export type MastraCodeDeliverySession = NonNullable<Awaited<ReturnType<AgentController<any>['getSession']>>>;

/** Where a notification goes: a session's stored thread, under the resource that owns that thread. */
export interface MastraCodeDeliveryTarget {
  sessionId: string;
  threadId: string;
  /** The thread's own resource (the Factory's, its owner's, or, before migration, the session id). */
  resourceId: string;
}

/**
 * What Mastra's notification inbox did with it. `woken`: the target thread was idle and the
 * notification started a run. `mid-run`: that thread was running; the run reads it when it next
 * checks its inbox. `persisted` and `summarized`: kept in Mastra's notification store, delivered
 * later by its dispatcher (or summarized now). `skipped`: nothing was sent (`offline`, a stage
 * notice for a session nobody has live; `session-not-found`, nobody to open it as) or the inbox
 * discarded it.
 */
export type MastraCodeDeliveryResult =
  | { delivered: 'woken' | 'mid-run' | 'persisted' | 'summarized'; notificationId: string; reason?: string }
  | { delivered: 'skipped'; notificationId?: string; reason: 'offline' | 'session-not-found' | 'discarded' };

/**
 * Deliver a notification to a Mastra Code session's stored thread, through Mastra's notification
 * inbox: the record lands in Mastra's notification store (which survives a restart) and the inbox
 * decides, by priority and whether the thread is running, to wake it, reach the running turn, or
 * keep it for later.
 *
 * Sent through the target's agent with an explicit `{ resourceId, threadId }`, never
 * `Session.sendNotificationSignal`: that one builds the wake from the sender's request context
 * and aims at the target's current thread. On this path the SDK builds the wake from the session
 * that owns the target resource, so the woken run is that session's owner, with their credentials.
 * A live session's thread is never switched.
 *
 * A target nobody has live is opened first with `openAsOwner` (as its Factory row's owner, bound
 * to the stored thread: waking a resource no session owns starts a run with no model), unless
 * `onlyIfLive` says to skip it.
 */
export async function deliverMastraCodeNotification(
  controller: Pick<MastraCodeDeliveryController, 'getSession' | 'getCurrentAgent'>,
  target: MastraCodeDeliveryTarget,
  notification: SendNotificationSignalInput,
  options: {
    onlyIfLive?: boolean;
    /**
     * Open the session nobody has live, as the person it belongs to; undefined when nobody can be. It is a
     * session this controller created (Factory sees it as a `RuntimeLiveSession`).
     */
    openAsOwner: () => Promise<RuntimeLiveSession | undefined>;
  },
): Promise<MastraCodeDeliveryResult> {
  // No request context: without a user the controller's access check is a no-op, and this is a
  // server-side lookup on the target's behalf, not the sender's.
  let session = await controller.getSession(target.sessionId);
  if (!session) {
    if (options.onlyIfLive) return { delivered: 'skipped', reason: 'offline' };
    session = (await options.openAsOwner()) as MastraCodeDeliverySession | undefined;
    if (!session) return { delivered: 'skipped', reason: 'session-not-found' };
  }

  // Read before sending: the send itself starts a run on an idle target. Delivery is per thread,
  // so a run on another thread of the same session leaves the target thread idle.
  const busy = session.stream.isActive() && session.thread.getId() === target.threadId;
  const result = await controller
    .getCurrentAgent(session)
    .sendNotificationSignal(notification, { resourceId: target.resourceId, threadId: target.threadId });
  await Promise.all([result.persisted, result.accepted].filter(Boolean));

  const notificationId = result.record.id;
  const reason = result.decision.reason ? { reason: result.decision.reason } : {};
  switch (result.decision.action) {
    case 'deliver':
      return { delivered: busy ? 'mid-run' : 'woken', notificationId, ...reason };
    case 'summarize':
      return { delivered: 'summarized', notificationId, ...reason };
    case 'discard':
      return { delivered: 'skipped', notificationId, reason: 'discarded' };
    default:
      return { delivered: 'persisted', notificationId, ...reason };
  }
}
