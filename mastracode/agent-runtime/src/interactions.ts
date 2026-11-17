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
  | { kind: 'tool_approval'; toolName: string; input: unknown; reason?: string }
  /**
   * A tool that paused for input only its own session can give (its runtime resumes it on a shape of
   * its own, such as Mastra Code's `request_access`). Nothing answers it from outside the session; it
   * is recorded so Factory knows the session waits.
   */
  | { kind: 'tool_input'; toolName: string; input: unknown };

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

/** Requests a person can answer from outside the session (every kind but `tool_input`). */
export type AnswerableRequest = Exclude<InteractionRequest, { kind: 'tool_input' }>;

export type AnswerableKind = AnswerableRequest['kind'];

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
  /**
   * The runtime that holds the call and takes its answer, when it is not a Factory tool awaiting the
   * broker (for example `mastra-code`, whose controller resumes its own suspended and gated calls).
   * The broker records such an interaction as the runtime reports it, hands an answer to the
   * runtime, and settles it on the runtime's word.
   */
  heldBy?: string;
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
