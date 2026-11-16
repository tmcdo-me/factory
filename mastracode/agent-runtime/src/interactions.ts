/**
 * Human-in-the-loop requests: questions, plan approvals and tool approvals.
 *
 * Interactions are owned by Factory, not by any runtime. A tool asks through
 * `FactoryToolContext.interact()`; the broker persists the request, announces it, and waits for an
 * answer from the UI, another session, or a board's auto-approval rule.
 */

export type InteractionRequest =
  | {
      kind: 'question';
      question: string;
      options?: { label: string; description?: string }[];
      /** `multiple` lets the human pick several options. */
      selection?: 'single' | 'multiple';
    }
  | { kind: 'plan_approval'; planPath: string; plan?: string }
  | { kind: 'tool_approval'; toolName: string; input: unknown; reason?: string };

export type InteractionKind = InteractionRequest['kind'];

export type InteractionResponse =
  | { kind: 'question'; answer: string | string[] }
  | {
      kind: 'plan_approval';
      action: 'approved' | 'rejected';
      feedback?: string;
      /** The plan as the human saw it, so the recorded result can replay it. */
      plan?: { path?: string; title?: string; content?: string };
    }
  | { kind: 'tool_approval'; approved: boolean; reason?: string };

export type ResponseFor<K extends InteractionKind> = Extract<InteractionResponse, { kind: K }>;

export type InteractionStatus = 'pending' | 'resolved' | 'cancelled';

export interface PendingInteraction {
  id: string;
  sessionId: string;
  /** The tool call that asked, when there is one. */
  callId?: string;
  request: InteractionRequest;
  /** ISO-8601. */
  requestedAt: string;
}

export interface InteractionRecord extends PendingInteraction {
  status: InteractionStatus;
  response?: InteractionResponse;
  resolvedBy?: string;
  /** ISO-8601. */
  settledAt?: string;
  cancelReason?: string;
}

/** Persistence for interactions. Factory provides a storage-backed implementation. */
export interface InteractionStore {
  create(record: InteractionRecord): Promise<void>;
  get(id: string): Promise<InteractionRecord | undefined>;
  /**
   * Settle a pending interaction. Must be atomic: returns the updated record, or `undefined` when the
   * interaction is missing or no longer pending (so two answers can't both win).
   */
  settle(
    id: string,
    settlement:
      | { status: 'resolved'; response: InteractionResponse; resolvedBy?: string; settledAt: string }
      | { status: 'cancelled'; cancelReason: string; settledAt: string },
  ): Promise<InteractionRecord | undefined>;
  listPending(filter?: { sessionId?: string }): Promise<InteractionRecord[]>;
}
