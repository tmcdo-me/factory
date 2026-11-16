import type { FactoryEvent, RunEndReason } from './events';
import type { InteractionResponse } from './interactions';
import type { FactoryToolContext, FactoryToolDef } from './tools';
import type { SessionWorkspace } from './workspace';

/**
 * An agent runtime: Mastra Code, Claude Agent, or a future one. Factory only ever talks to agents
 * through this interface and `RuntimeSession`.
 */
export interface AgentRuntime {
  /** Stable id stored with sessions and project defaults, e.g. `mastra-code`, `claude-agent`. */
  readonly id: string;
  /** UI label, e.g. `Mastra Code`, `Claude Agent`. */
  readonly label: string;
  readonly capabilities: RuntimeCapabilities;
  listModels(ctx: TenantContext): Promise<RuntimeModel[]>;
  /**
   * Open a session: create it, or resume it when `spec.runtimeState` is set. Idempotent per
   * `sessionId` within a process: a second call returns the live session.
   */
  openSession(spec: SessionSpec): Promise<RuntimeSession>;
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface RuntimeCapabilities {
  /** Sandbox kinds the runtime can work in. */
  sandboxes: ReadonlyArray<SessionWorkspace['kind']>;
  /** The runtime runs its own subagents (reported as nested tool calls). */
  subagents: boolean;
  /** Supported thinking/effort levels, lowest first. Empty when not configurable. */
  thinkingLevels: readonly ThinkingLevel[];
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RuntimeModel {
  /** Runtime-scoped model id, passed back in `SessionSpec.model` / `setModel`. */
  id: string;
  label: string;
  /** Whether the tenant currently has what the model needs (credentials, enabled provider). */
  available: boolean;
  unavailableReason?: string;
}

export interface TenantContext {
  orgId: string;
  userId: string;
  projectId?: string;
}

export interface SessionOwner {
  orgId: string;
  userId: string;
  /** Whose memory/threads the session uses; several sessions may share it. */
  resourceId: string;
}

/**
 * Context Factory injects into the agent: the work item, the board phase, environment facts.
 * Evaluated at the start of every turn so the agent always sees current values.
 */
export interface ContextProvider {
  /** Stable key; a runtime may replace an earlier block with the same key. */
  key: string;
  render(): Promise<string | undefined>;
}

export interface SessionSpec {
  sessionId: string;
  owner: SessionOwner;
  workspace: SessionWorkspace;
  /** Factory tools bound for this session. */
  tools: FactoryToolDef[];
  context: ContextProvider[];
  /** Factory's role instructions. The runtime adds its own system prompt around these. */
  instructions: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Adapter-private resume state from a previous `RuntimeSession.runtimeState()`. Opaque to Factory. */
  runtimeState?: unknown;
  /** Called with every event the session produces. Factory persists and fans them out. */
  emit(event: FactoryEvent): void;
  /**
   * Ask the human from runtime-native code paths (e.g. a runtime's own permission prompt).
   * Factory tools use `FactoryToolContext.interact` instead.
   */
  interact: FactoryToolContext['interact'];
}

export type Author = { kind: 'user'; userId: string } | { kind: 'factory'; reason: string };

export type TurnInput =
  | { kind: 'message'; text: string; author: Author; attachments?: Attachment[] }
  | {
      kind: 'skill';
      skillName: string;
      /** The resolved skill text sent to the agent as the turn's message. */
      text: string;
      arguments?: string;
      /** Idempotency key: a repeated `deliveryId` for the same session is ignored. */
      deliveryId: string;
    }
  /**
   * An answer that arrived after the session's live run was gone (e.g. a restart). The runtime
   * delivers it however it resumes best: natively, or as a message.
   */
  | { kind: 'interaction_response'; interactionId: string; callId?: string; response: InteractionResponse };

export interface Attachment {
  name: string;
  mediaType: string;
  /** Path inside the sandbox, or a data URL. */
  uri: string;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_interaction' | 'closed';

export interface RunHandle {
  runId: string;
  /** Resolves when the run ends (any reason). Never rejects; failures arrive as `run.ended`. */
  done: Promise<{ reason: RunEndReason }>;
}

export interface RuntimeSession {
  readonly id: string;
  readonly runtimeId: string;
  status(): SessionStatus;
  /** Start a turn. Rejects only for misuse (closed session); a run already in progress queues. */
  send(input: TurnInput): Promise<RunHandle>;
  abort(reason?: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setThinkingLevel?(level: ThinkingLevel): Promise<void>;
  /** Opaque state Factory stores so `openSession` can resume after a restart. */
  runtimeState(): unknown;
  close(): Promise<void>;
}
