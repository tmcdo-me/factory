import type { InteractionResponse } from './interactions';
import type { ThinkingLevel } from './thinking';

/**
 * Commands Factory's session API sends to a session, whatever runtime runs it. Each runtime adapter
 * provides an implementation; Factory's routes only see this interface.
 *
 * `request` is the host's per-request context (identity, tenant and credential primers), passed
 * through untouched so the runtime authenticates the turn exactly as the host's middleware set it up.
 */
export interface SessionCommands {
  send(sessionId: string, input: SendInput, request: CommandRequest): Promise<CommandResult>;
  abort(sessionId: string, request: CommandRequest): Promise<CommandResult>;
  /** Answer a pending interaction, addressed by its id or by the tool call that asked. */
  answer(
    sessionId: string,
    target: { interactionId?: string; callId?: string },
    response: InteractionResponse,
    request: CommandRequest,
  ): Promise<CommandResult>;
  setModel(
    sessionId: string,
    model: { modelId: string; thinkingLevel?: ThinkingLevel },
    request: CommandRequest,
  ): Promise<CommandResult>;
}

export interface SendInput {
  text: string;
  files?: { data: string; mediaType: string; filename?: string }[];
}

export interface CommandRequest {
  /** Opaque host request context. */
  context: unknown;
}

export type CommandResult =
  | { ok: true }
  | {
      ok: false;
      reason: CommandFailure;
      message?: string;
      /**
       * fork(claude-agent): the runtime still waits on the interaction after refusing this answer
       * (its resume could not start), so it stays pending whatever its events said meanwhile.
       */
      waiting?: boolean;
    };

export type CommandFailure =
  /** No session with that id is running or can be resumed. */
  | 'session_not_found'
  /** The interaction was already answered, cancelled, or never existed. */
  | 'not_pending'
  /** The request is malformed for this runtime (e.g. unknown interaction kind). */
  | 'invalid'
  /** fork(claude-agent): which runtime the session runs on couldn't be read; retry. */
  | 'unavailable';
