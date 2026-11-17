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
  /** Empty when the controller names none (each id is); callers that need one check it. */
  sessionId: string;
  resourceId: string;
  threadId: string;
  /** The session's state (Factory's project and repository tags among it); empty when it has none. */
  state(): Partial<State>;
  /** The workspace the session's controller holds, when it has one. */
  workspace?: unknown;
  /** The runtime's session record: its id and owner, when the controller carries one. */
  session?: { id: string; ownerId: string };
  /** The model the session runs, when the controller carries one (trimmed, never empty). */
  modelId?: string;
}

interface ControllerEntry {
  sessionId?: unknown;
  resourceId?: unknown;
  threadId?: unknown;
  workspace?: unknown;
  session?: { id?: unknown; ownerId?: unknown; modelId?: unknown };
  getState?: () => unknown;
}

/**
 * The turn's raw `controller` entry, for the few Mastra Code internals that act on the live controller
 * session (healing a recovered session's state, emitting an event). Everything that only reads the
 * session uses {@link turnSession}; this is the one other place the key is named.
 */
export function controllerEntry<T = unknown>(requestContext: RequestContext | undefined): T | undefined {
  if (typeof requestContext?.get !== 'function') return undefined;
  return requestContext.get('controller') as T | undefined;
}

/** The turn's session, or `undefined` when the request context carries no controller entry. */
export function turnSession<State extends Record<string, unknown> = Record<string, unknown>>(
  requestContext: RequestContext | undefined,
): TurnSession<State> | undefined {
  if (typeof requestContext?.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as ControllerEntry | undefined;
  if (!controller || typeof controller !== 'object') return undefined;
  const { sessionId, resourceId, threadId } = controller;
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    resourceId: typeof resourceId === 'string' ? resourceId : '',
    threadId: typeof threadId === 'string' ? threadId : '',
    state: () => {
      const state = controller.getState?.();
      return (state && typeof state === 'object' ? state : {}) as Partial<State>;
    },
    ...(typeof controller.session?.modelId === 'string' && controller.session.modelId.trim()
      ? { modelId: controller.session.modelId.trim() }
      : {}),
    ...(controller.workspace !== undefined ? { workspace: controller.workspace } : {}),
    ...(typeof controller.session?.id === 'string'
      ? {
          session: {
            id: controller.session.id,
            ownerId: typeof controller.session.ownerId === 'string' ? controller.session.ownerId : '',
          },
        }
      : {}),
  };
}
