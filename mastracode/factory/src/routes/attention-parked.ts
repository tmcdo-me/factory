/** Sessions parked on a tool, read live from the registry: the item exists exactly as long as an answer is owed. */

import type { LiveSessions } from '../session/live-sessions.js';
import type { ParkedInteraction } from '../session/parked-interaction.js'; // fork(claude-agent)
import type {
  FactoryAttentionIdentity,
  FactoryAttentionReceiptRecord,
  Card,
  WorkItemsStorage,
} from '../storage/domains/work-items/base.js';
import { factoryAgentWaitingAttentionIdentity, factoryAttentionKey } from '../storage/domains/work-items/base.js';
import type {
  AttentionCounts,
  AttentionEntry,
  AttentionLatest,
  AttentionPageArgs,
  AttentionPageResult,
  AttentionProvider,
  AttentionScope,
  AttentionStreamPosition,
} from './attention-providers.js';
import { matchesView, receiptScope } from './attention-providers.js';

interface ParkedSession {
  item: Pick<Card, 'id' | 'title'>;
  role: string;
  sessionId: string;
  threadId: string;
  toolName: string;
  occurredAt: Date;
  identity: FactoryAttentionIdentity;
  /** fork(claude-agent): what it asks, so the inbox can answer it. */
  interaction?: ParkedInteraction;
}

interface ReceiptedParkedSession {
  entry: ParkedSession;
  receipt: FactoryAttentionReceiptRecord | undefined;
}

/** fork(claude-agent): the most of a plan the inbox carries (64 KB); the session shows the rest. */
const MAX_INBOX_PLAN = 64 * 1024;
/** fork(claude-agent): the most of a gated call's arguments the inbox carries, as JSON (4 KB). */
const MAX_INBOX_TOOL_INPUT = 4 * 1024;

/** fork(claude-agent): what a parked call asks, capped for a list of many. */
function inboxInteraction(interaction: ParkedInteraction): ParkedInteraction {
  const { request } = interaction;
  if (request.kind === 'plan_approval' && request.plan && request.plan.length > MAX_INBOX_PLAN) {
    return {
      ...interaction,
      request: {
        ...request,
        plan: `${request.plan.slice(0, MAX_INBOX_PLAN)}\n\n…(cut short here: open the session for the whole plan)`,
      },
    };
  }
  if (request.kind === 'tool_approval') {
    const input = JSON.stringify(request.input ?? null);
    if (input.length > MAX_INBOX_TOOL_INPUT) {
      return { ...interaction, request: { ...request, input: `${input.slice(0, MAX_INBOX_TOOL_INPUT)}…` } };
    }
  }
  return interaction;
}

export function parkedRunLabel(toolName: string): string {
  return toolName === 'submit_plan' ? 'Plan waiting for review' : 'Agent is waiting for an answer';
}

function olderThan(entry: ParkedSession, before: AttentionStreamPosition | undefined): boolean {
  if (!before) return true;
  const gap = entry.occurredAt.getTime() - before.occurredAt.getTime();
  return gap < 0 || (gap === 0 && entry.sessionId.localeCompare(before.id) > 0);
}

function toItem(scope: AttentionScope, { entry, receipt }: ReceiptedParkedSession): Record<string, unknown> {
  return {
    key: factoryAttentionKey(scope.factoryProjectId, entry.identity),
    kind: 'agent-waiting' as const,
    sessionId: entry.sessionId,
    threadId: entry.threadId,
    role: entry.role,
    toolName: entry.toolName,
    occurrence: entry.identity.occurrence,
    workItemId: entry.item.id,
    title: entry.item.title,
    detail: parkedRunLabel(entry.toolName),
    occurredAt: entry.occurredAt.toISOString(),
    read: receipt !== undefined,
    archived: receipt?.state === 'archived',
    target: { kind: 'thread' as const, sessionId: entry.sessionId, threadId: entry.threadId },
    // fork(claude-agent): the call it waits on and what it asks (a question and its options, a plan).
    ...(entry.interaction ? { interaction: inboxInteraction(entry.interaction) } : {}),
  };
}

export class ParkedRunAttentionProvider implements AttentionProvider {
  readonly kind = 'agent-waiting' as const;
  readonly #workItems: WorkItemsStorage;
  readonly #liveSessions: Pick<LiveSessions, 'parkedIn'>;

  constructor({
    workItems,
    liveSessions,
  }: {
    workItems: WorkItemsStorage;
    liveSessions: Pick<LiveSessions, 'parkedIn'>;
  }) {
    this.#workItems = workItems;
    this.#liveSessions = liveSessions;
  }

  /** Newest park first. A session bound to several cards is listed once, under the first card. */
  async #parked(scope: AttentionScope): Promise<ParkedSession[]> {
    const runBySession = new Map(
      this.#liveSessions.parkedIn(scope.factoryProjectId).map(({ sessionId, run }) => [sessionId, run]),
    );
    if (runBySession.size === 0) return [];
    const items = await this.#workItems.listShared({ orgId: scope.orgId, factoryProjectId: scope.factoryProjectId });
    const bySession = new Map<string, ParkedSession>();
    for (const item of items) {
      for (const [role, ref] of Object.entries(item.sessions)) {
        const run = runBySession.get(ref.sessionId);
        if (!run || bySession.has(ref.sessionId)) continue;
        bySession.set(ref.sessionId, {
          item,
          role,
          sessionId: ref.sessionId,
          threadId: ref.threadId,
          toolName: run.toolName,
          occurredAt: new Date(run.suspendedAt),
          identity: factoryAgentWaitingAttentionIdentity(ref.sessionId, run.suspendedAt),
          ...(run.interaction ? { interaction: run.interaction } : {}), // fork(claude-agent)
        });
      }
    }
    return [...bySession.values()].sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.sessionId.localeCompare(b.sessionId),
    );
  }

  async #withReceipts(scope: AttentionScope, parked: ParkedSession[]): Promise<ReceiptedParkedSession[]> {
    const receipts = await this.#workItems.listAttentionReceipts({
      ...receiptScope(scope),
      identities: parked.map(entry => entry.identity),
    });
    const byKey = new Map(receipts.map(receipt => [factoryAttentionKey(scope.factoryProjectId, receipt), receipt]));
    return parked.map(entry => ({
      entry,
      receipt: byKey.get(factoryAttentionKey(scope.factoryProjectId, entry.identity)),
    }));
  }

  async counts(scope: AttentionScope): Promise<AttentionCounts> {
    let open = 0;
    let unread = 0;
    for (const { receipt } of await this.#withReceipts(scope, await this.#parked(scope))) {
      if (receipt?.state !== 'archived') open += 1;
      if (receipt === undefined) unread += 1;
    }
    return { open, unread };
  }

  async latest(scope: AttentionScope): Promise<AttentionLatest | null> {
    const [newest] = await this.#withReceipts(scope, (await this.#parked(scope)).slice(0, 1));
    if (!newest) return null;
    return {
      key: factoryAttentionKey(scope.factoryProjectId, newest.entry.identity),
      at: newest.entry.occurredAt,
      unread: newest.receipt === undefined,
    };
  }

  async page(scope: AttentionScope, { view, search, before, limit }: AttentionPageArgs): Promise<AttentionPageResult> {
    const parked = (await this.#parked(scope)).filter(entry => olderThan(entry, before));
    const entries: AttentionEntry[] = [];
    for (const receipted of await this.#withReceipts(scope, parked)) {
      const { entry, receipt } = receipted;
      if (!matchesView(view, receipt)) continue;
      if (search && !`${entry.item.title} ${parkedRunLabel(entry.toolName)}`.toLowerCase().includes(search)) continue;
      if (entries.length === limit) return { entries, hasMore: true };
      entries.push({
        occurredAt: entry.occurredAt,
        resumeCursor: { occurredAt: entry.occurredAt, id: entry.sessionId },
        item: toItem(scope, receipted),
      });
    }
    return { entries, hasMore: false };
  }

  async markAllRead(
    scope: AttentionScope,
    { before, now }: { before?: AttentionStreamPosition; now: Date },
  ): Promise<{ hasMore: boolean }> {
    const parked = (await this.#parked(scope)).filter(entry => olderThan(entry, before));
    if (parked.length > 0) {
      await this.#workItems.markAttentionReceiptsRead({
        ...receiptScope(scope),
        identities: parked.map(entry => entry.identity),
        now,
      });
    }
    return { hasMore: false };
  }
}
