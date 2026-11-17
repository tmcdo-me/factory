import type { AuditAction } from '@mastra/factory/storage/domains/audit/actions';
import { isHumanActorId } from '@mastra/factory/storage/domains/audit/actors';

import { sourceMetadata } from './boardItems';
import type { AuditActorProfile, AuditEvent, AuditEventPage } from './services/audit';
import type { WorkItem } from './services/workItems';

export interface WorkItemActivity {
  events: AuditEvent[];
  lastWorker?: AuditActorProfile;
  /**
   * Extra actor profiles derived locally (from external metadata like
   * `metadata.author` on GitHub items). Merged with the server-side
   * `AuditEventPage.actors` when the UI renders the timeline so external
   * authors on synthetic "created" events resolve to a name + avatar.
   */
  extraActors: Record<string, AuditActorProfile>;
}

function actorProfile(actorId: string, actors: Record<string, AuditActorProfile>): AuditActorProfile | undefined {
  return actors[actorId];
}

function metadataString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Best-effort creator attribution for external items. GitHub exposes a stable
 * public avatar URL.
 */
function externalCreatorProfile(item: WorkItem): AuditActorProfile | undefined {
  if (item.source === 'github-issue' || item.source === 'github-pr') {
    const author = metadataString(sourceMetadata(item), 'author');
    if (!author) return undefined;
    return {
      id: `github:${author}`,
      name: author,
      avatarUrl: `https://github.com/${encodeURIComponent(author)}.png?size=64`,
    };
  }
  return undefined;
}

export const CREATED_ACTION = 'factory.work_item.created' satisfies AuditAction;
export const ASSIGNED_ACTION = 'factory.work_item.assigned';

/**
 * Synthesize a "created" event from the item itself so review boards populated
 * by external ingestion (which have no audit event yet) still show *something*
 * on the timeline. Only emitted when no real create event is already in the
 * audit page, so we don't duplicate history when it exists.
 */
function syntheticCreatedEvent(item: WorkItem, hasRealCreateEvent: boolean): AuditEvent | undefined {
  if (hasRealCreateEvent) return undefined;
  const isHuman = isHumanActorId(item.createdBy);
  const creator = externalCreatorProfile(item);
  return {
    id: `synthetic-created:${item.id}`,
    actorId: isHuman ? item.createdBy : (creator?.id ?? item.createdBy),
    actorType: 'human',
    action: CREATED_ACTION,
    targets: [{ type: 'work_item', id: item.id, name: item.title }],
    metadata: {},
    occurredAt: item.createdAt,
  };
}

function targetsWorkItem(event: AuditEvent, workItemId: string): boolean {
  return event.targets.some(target => target.type === 'work_item' && target.id === workItemId);
}

function latestStageWorker(item: WorkItem): { actorId: string; occurredAt: string } | undefined {
  const candidates = item.stageHistory.flatMap(entry => {
    const actors: Array<{ actorId: string; occurredAt: string }> = [];
    if (isHumanActorId(entry.by)) actors.push({ actorId: entry.by, occurredAt: entry.enteredAt });
    if (entry.exitedAt && isHumanActorId(entry.exitedBy)) {
      actors.push({ actorId: entry.exitedBy, occurredAt: entry.exitedAt });
    }
    return actors;
  });
  return candidates.reduce<{ actorId: string; occurredAt: string } | undefined>((latest, candidate) => {
    if (!latest || candidate.occurredAt > latest.occurredAt) return candidate;
    return latest;
  }, undefined);
}

export function workItemActivity(item: WorkItem, page: AuditEventPage | undefined): WorkItemActivity {
  const actors = page?.actors ?? {};
  const auditEvents = page?.events.filter(event => targetsWorkItem(event, item.id)) ?? [];
  const hasRealCreated = auditEvents.some(event => event.action === CREATED_ACTION);

  const creator = externalCreatorProfile(item);

  const created = syntheticCreatedEvent(item, hasRealCreated);
  // Timeline is newest-first; the synthetic created entry goes at the end (older).
  const events = created ? [...auditEvents, created] : auditEvents;

  const extraActors: Record<string, AuditActorProfile> = {};
  if (creator) extraActors[creator.id] = creator;

  const latestHumanEvent = auditEvents.find(event => event.actorType === 'human' && isHumanActorId(event.actorId));
  const latestStage = latestStageWorker(item);
  const sessionActorId = Object.values(item.sessions)
    .map(session => session.startedBy)
    .find(isHumanActorId);
  const createdBy = isHumanActorId(item.createdBy) ? item.createdBy : undefined;

  // Try each internal source in order; only pick one that has a resolvable
  // profile.
  const candidateActorIds = [latestHumanEvent?.actorId, latestStage?.actorId, sessionActorId, createdBy].filter(
    isHumanActorId,
  );
  for (const actorId of candidateActorIds) {
    const profile = actorProfile(actorId, actors);
    if (profile) return { events, lastWorker: profile, extraActors };
  }

  // Nothing internal resolves — fall back to the external contributor who opened it.
  return { events, extraActors, ...(creator ? { lastWorker: creator } : {}) };
}

/** Comments render as themselves; the audit row each one also writes would show it twice. */
export function timelineEvents(activity: WorkItemActivity): AuditEvent[] {
  return activity.events.filter(event => !event.action.includes('.comment_'));
}
