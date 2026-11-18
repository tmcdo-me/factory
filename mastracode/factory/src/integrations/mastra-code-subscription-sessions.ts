// fork(claude-agent): how a provider event reaches a Mastra Code session. Mastra Code internal: it moves
// into `@factory/runtime-mastra-code` with the adapter (slice 7); the integrations see `SubscriptionSessions`.
import type { RuntimeController, RuntimeLiveSession } from '@factory/agent-runtime'; // fork(claude-agent)
import type { AgentChannels } from '@mastra/core/channels';
import type { SendNotificationSignalInput } from '@mastra/core/notifications';
import { RequestContext } from '@mastra/core/request-context';

import { hasResolvedOrg, seedSessionOrg } from '../session/org-seed.js';
import type { FactorySessionOwner, SubscriptionSessionLookup, SubscriptionSessionRow } from './subscription-session.js';

export type MastraCodeController = RuntimeController;

/** A subscribed thread's session, open for delivery. */
export interface SubscriptionSession {
  /** Hand the notification to the session, resolving once it is stored and accepted. */
  notify(notification: SendNotificationSignalInput, requestContext: RequestContext): Promise<void>;
}

/**
 * How an integration reaches the sessions its subscriptions name, whatever runs them. Provider-neutral.
 */
export interface SubscriptionSessions {
  /**
   * The session that owns the subscribed thread, brought online as the Factory row's owner when it is
   * not live. `undefined` when this deployment does not hold the thread. Throws when it cannot be opened.
   */
  open(
    subscription: SubscriptionSessionRow,
    options: { label: string; sourceControl?: SubscriptionSessionLookup },
  ): Promise<SubscriptionSession | undefined>;
  /** The chat channels sessions announce in, once mounted. */
  channels(): AgentChannels | null | undefined;
}

/** The Mastra Code adapter's subscription sessions, over its mounted controller. */
export function mastraCodeSubscriptionSessions(controller: MastraCodeController): SubscriptionSessions {
  return {
    async open(subscription, options) {
      const session = await resolveSubscriptionSession(controller, subscription, options);
      if (!session) return undefined;
      return {
        async notify(notification, requestContext) {
          const result = await session.sendNotificationSignal(notification, { requestContext });
          await Promise.all([result.persisted, result.accepted].filter(Boolean));
        },
      };
    },
    channels: () => controller.getChannels?.(),
  };
}

/**
 * Create the controller session for a Factory session that isn't live, as its
 * row's owner in the row's organization. Used when an event or message has to
 * reach a session nobody has open: there is no signed-in user, so the session
 * runs as the person it belongs to.
 */
export async function createSessionAsRowOwner<TSession extends RuntimeLiveSession = RuntimeLiveSession>(
  controller: Pick<RuntimeController<TSession>, 'createSession'>,
  args: {
    sessionId: string;
    ownerResourceId: string;
    row: FactorySessionOwner;
    tags: Record<string, string>;
    /** Bind this exact thread at creation instead of resuming or creating another. */
    threadId?: string;
  },
) {
  const requestContext = new RequestContext();
  requestContext.set('user', { workosId: args.row.userId, organizationId: args.row.orgId });
  const session = await controller.createSession({
    id: args.sessionId,
    ownerId: args.row.userId,
    resourceId: args.ownerResourceId,
    tags: args.tags,
    ...(args.threadId ? { threadId: args.threadId } : {}),
    requestContext,
  });
  await seedSessionOrg(session, args.row.orgId);
  return session;
}

export async function resolveSubscriptionSession(
  controller: MastraCodeController,
  subscription: SubscriptionSessionRow,
  options: { label: string; sourceControl?: SubscriptionSessionLookup },
) {
  const { label } = options;
  const { sessionId, resourceId, threadId } = subscription;
  if (!sessionId || !resourceId || !threadId) {
    throw new Error(`${label} subscription ${subscription.id} is missing its session binding.`);
  }
  // Read the thread straight from storage before touching sessions. This answers
  // two questions at once, and `queryThreadById` does it without constructing a
  // session (so no workspace or sandbox is provisioned just to make the check).
  //
  // First: do we even have this thread? A change request's events can reach a
  // deployment that never owned the subscribed thread, and delivery must not
  // fabricate a session for a thread that lives somewhere else.
  //
  // Second: which resource owns it? The subscription records the Factory project
  // as its `resourceId`, but the session may run under a different resource
  // (its own id, for sessions created before Factory resources were shared).
  // The thread row is the authoritative answer; the stored id is only a fallback.
  const thread = await controller.queryThreadById({ threadId });
  if (!thread) return undefined;
  const ownerResourceId = thread.resourceId || resourceId;
  let session = await controller.getSession(sessionId);
  if (!session) {
    const tags = {
      factoryProjectId: resourceId,
      projectRepositoryId: subscription.data.projectRepositoryId,
    };
    // Creating the session resolves its workspace, which authorizes the caller
    // against the Factory session row — no signed-in user, so run as its owner.
    // The session is created under the resource that owns the thread, so the
    // thread switch below resolves; the persisted Factory session is keyed by
    // the subscription's session ID.
    const sessionRow = await options.sourceControl?.sessions.getBySessionId(sessionId);
    if (!sessionRow) {
      throw new Error(`${label} subscription ${subscription.id} has no Factory session ${sessionId} to run as.`);
    }
    session = await createSessionAsRowOwner(controller, {
      sessionId,
      ownerResourceId,
      row: sessionRow,
      tags,
    });
  } else if (!hasResolvedOrg(session.state?.get()?.factoryOrgId)) {
    // A session created before the org seed existed carries the project tag and
    // no org, so capture would refuse for the rest of its life even though the
    // org is recoverable. Heal it — but only here, and only when it is missing:
    // hoisting the row fetch above would make an existing-session delivery throw
    // on a missing row where it previously succeeded, and fetching it every time
    // would add a storage read to every delivery. A row that is missing or a
    // lookup that throws leaves the session marked unresolved, and delivery
    // continues either way.
    try {
      const sessionRow = await options.sourceControl?.sessions.getBySessionId(sessionId);
      await seedSessionOrg(session, sessionRow?.orgId);
    } catch (error) {
      console.warn(`[${label} webhook] Unable to resolve the session organization.`, error);
      await seedSessionOrg(session, undefined);
    }
  } else if (session.state?.get()?.factoryOrgUnresolved) {
    // The org is present, so an earlier failed resolution left a stale marker
    // behind. Clear it without a storage read — nothing else re-seeds a session
    // once the start hook has run, so the marker would otherwise outlive its
    // cause.
    await seedSessionOrg(session, session.state.get()?.factoryOrgId);
  }
  if (session.thread.getId() !== threadId) {
    await session.thread.switch({ threadId, emitEvent: false });
  }
  if (session.thread.getId() !== threadId) {
    throw new Error(`Session ${sessionId} did not bind thread ${threadId}.`);
  }
  return session;
}
