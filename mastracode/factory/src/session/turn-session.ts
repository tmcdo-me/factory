// fork(claude-agent): the session a turn runs in, read from the turn's request context (slice 4).
import type { RequestContext } from '@mastra/core/request-context';

/**
 * The session a turn runs in, as its request context carries it under `controller`: Mastra Code's
 * agent controller puts its session there, and Claude Agent's turns carry the same shape
 * (`claudeAgentRequestContext`). Code that reads it through {@link turnSession} depends on these
 * fields, not on Mastra Code's types. Not all of Factory does yet: the remaining direct reads of
 * `controller` are listed under slice 7 in the spec.
 */
export interface TurnSession<State extends Record<string, unknown> = Record<string, unknown>> {
  sessionId: string;
  resourceId: string;
  threadId: string;
  /** The session's state (Factory's project and repository tags among it); empty when it has none. */
  state(): Partial<State>;
  /** The workspace the session's controller holds, when it has one. */
  workspace?: unknown;
}

interface ControllerEntry {
  sessionId?: unknown;
  resourceId?: unknown;
  threadId?: unknown;
  workspace?: unknown;
  getState?: () => unknown;
}

/** The turn's session, or `undefined` when the request context carries none (or no usable ids). */
export function turnSession<State extends Record<string, unknown> = Record<string, unknown>>(
  requestContext: RequestContext | undefined,
): TurnSession<State> | undefined {
  if (typeof requestContext?.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as ControllerEntry | undefined;
  const { sessionId, resourceId, threadId } = controller ?? {};
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  return {
    sessionId,
    resourceId: typeof resourceId === 'string' ? resourceId : '',
    threadId: typeof threadId === 'string' ? threadId : '',
    state: () => {
      const state = controller?.getState?.();
      return (state && typeof state === 'object' ? state : {}) as Partial<State>;
    },
    ...(controller?.workspace !== undefined ? { workspace: controller.workspace } : {}),
  };
}
