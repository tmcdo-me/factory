import { RequestContext } from '@mastra/core/request-context';

import { primeTenantCredentialsForRequestContext } from '../routes/tenant-credentials.js';
import { hasResolvedOrg } from '../session/org-seed.js';
import type { IntegrationSubscription } from '../storage/domains/integrations/base.js';

/** The Factory session row fields a woken session has to run as. */
export type FactorySessionOwner = { userId: string; orgId: string };

export interface SubscriptionSessionLookup {
  sessions: { getBySessionId(sessionId: string): Promise<FactorySessionOwner | null> };
}

/**
 * Bring the session that owns a subscribed thread online so a provider event
 * can be delivered to it. Provider-neutral: every source-control provider's
 * subscriptions carry the same session binding and differ only in their target data.
 */
export type SubscriptionSessionRow = IntegrationSubscription<{
  projectRepositoryId: string;
  subscribedByUserId?: string | null;
}>;

/**
 * The request context a provider-triggered run executes under: the user who
 * subscribed the thread, in the subscription's organization. A webhook carries
 * no signed-in user and tenant credential resolution fails closed without one,
 * so a woken run would otherwise stop before it could persist or answer the
 * notification. The subscription row already names that user, so delivery
 * costs no extra read; an older row without one falls back to the Factory
 * session's owner, the identity used when a session is recreated for delivery.
 */
export async function subscriptionRunContext(
  subscription: SubscriptionSessionRow,
  sourceControl: SubscriptionSessionLookup | undefined,
): Promise<RequestContext | undefined> {
  let userId = subscription.data.subscribedByUserId ?? undefined;
  let orgId: string | undefined = subscription.orgId;
  if (!userId && subscription.sessionId && sourceControl) {
    const sessionRow = await sourceControl.sessions.getBySessionId(subscription.sessionId);
    userId = sessionRow?.userId;
    orgId = sessionRow?.orgId ?? orgId;
  }
  if (!userId || !hasResolvedOrg(orgId)) return undefined;
  const requestContext = new RequestContext();
  requestContext.set('user', { workosId: userId, organizationId: orgId });
  // The web auth middleware primes credential snapshots per request; a
  // webhook-triggered run has no request, so prime here or the model resolves
  // against an empty snapshot and the run fails closed before persisting. A
  // priming failure propagates: handing back an unprimed context would let the
  // caller accept the delivery, and retire a terminal subscription, for a run
  // that then fails without its credentials and cannot be redelivered.
  try {
    await primeTenantCredentialsForRequestContext(requestContext);
  } catch (error) {
    throw new Error(`Unable to prime tenant credentials for subscription ${subscription.id}; not delivered.`, {
      cause: error,
    });
  }
  return requestContext;
}

/**
 * Attach the Factory session's owner, in its organization, to the request
 * context of a run that has no inbound request (a notification or peer-signal
 * wake), and prime that tenant's credentials. The live session's `ownerId`
 * isn't used: sessions opened from the browser or Slack are owned by the
 * controller id, not a user. Leaves the context alone when `sessionId` names no
 * Factory session or its org is unresolved, so credential resolution fails
 * closed.
 */
export async function prepareSessionRunContext(
  requestContext: RequestContext,
  sessionId: string,
  sourceControl: SubscriptionSessionLookup,
  options?: { expectedOrgId?: string },
): Promise<'prepared' | 'session-not-found' | 'organization-unresolved' | 'organization-mismatch'> {
  const sessionRow = await sourceControl.sessions.getBySessionId(sessionId);
  if (!sessionRow) return 'session-not-found';
  if (!hasResolvedOrg(sessionRow.orgId)) return 'organization-unresolved';
  if (options?.expectedOrgId !== undefined && sessionRow.orgId !== options.expectedOrgId) {
    return 'organization-mismatch';
  }
  requestContext.set('user', { workosId: sessionRow.userId, organizationId: sessionRow.orgId });
  await primeTenantCredentialsForRequestContext(requestContext);
  return 'prepared';
}
