// fork(claude-agent): Factory's live Claude Agent sessions.
import { SessionPublisher } from '@factory/agent-runtime';
import type { CommandResult, SessionCommands, SessionEventHub } from '@factory/agent-runtime';
import { CLAUDE_AGENT_RUNTIME_ID, ClaudeAgentSession, claudeProcessEnv } from '@factory/runtime-claude-agent';
import type { QueryFn } from '@factory/runtime-claude-agent';

import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';

export interface ClaudeAgentSessionsDeps {
  hub: SessionEventHub;
  sessions: {
    get(sessionId: string): Promise<AgentSessionRecord | undefined>;
    setRuntimeState(sessionId: string, state: unknown): Promise<void>;
    setModel(sessionId: string, modelId: string): Promise<void>;
  };
  /**
   * The session's working directory and sandbox environment. Starting the sandbox clones the
   * repository, so this can take a while on first use. Rejects when the caller may not use it.
   */
  workspace(sessionId: string, requestContext: unknown): Promise<{ cwd: string; env: Record<string, string> }>;
  /** Factory's instructions for every Claude Agent session. */
  instructions?: string;
  hostEnv?: Record<string, string | undefined>;
  query?: QueryFn;
}

/**
 * Opens (or resumes) a session's Claude Code on first use, keeps one per session in this process,
 * and persists Claude's resume state whenever it changes so a restart picks the conversation up.
 */
export class ClaudeAgentSessions {
  readonly #deps: ClaudeAgentSessionsDeps;
  readonly #live = new Map<string, Promise<ClaudeAgentSession | undefined>>();

  constructor(deps: ClaudeAgentSessionsDeps) {
    this.#deps = deps;
  }

  /** The live session, opening it if this session runs on Claude Agent. */
  open(sessionId: string, requestContext: unknown): Promise<ClaudeAgentSession | undefined> {
    const existing = this.#live.get(sessionId);
    if (existing) return existing;
    const opening = this.#open(sessionId, requestContext).catch(error => {
      this.#live.delete(sessionId);
      throw error;
    });
    this.#live.set(sessionId, opening);
    return opening;
  }

  async #open(sessionId: string, requestContext: unknown): Promise<ClaudeAgentSession | undefined> {
    const record = await this.#deps.sessions.get(sessionId);
    if (record?.runtimeId !== CLAUDE_AGENT_RUNTIME_ID) {
      this.#live.delete(sessionId);
      return undefined;
    }
    const { cwd, env } = await this.#deps.workspace(sessionId, requestContext);
    const publisher = new SessionPublisher(this.#deps.hub, sessionId, {
      onError: error => console.warn(`[factory] Claude Agent session ${sessionId}: storing events failed`, error),
    });
    let savedState = JSON.stringify(record.runtimeState ?? {});
    const resume = (record.runtimeState as { claudeSessionId?: string } | undefined)?.claudeSessionId;
    const session: ClaudeAgentSession = new ClaudeAgentSession({
      sessionId,
      cwd,
      env: claudeProcessEnv(this.#deps.hostEnv ?? process.env, env),
      ...(record.modelId ? { model: record.modelId } : {}),
      ...(resume ? { resume } : {}),
      ...(this.#deps.instructions ? { instructions: this.#deps.instructions } : {}),
      ...(this.#deps.query ? { query: this.#deps.query } : {}),
      emit: event => {
        publisher.emit(event);
        if (event.type !== 'model.changed' && event.type !== 'run.ended') return;
        const state = JSON.stringify(session.runtimeState());
        if (state === savedState) return;
        savedState = state;
        this.#deps.sessions
          .setRuntimeState(sessionId, session.runtimeState())
          .catch(error =>
            console.warn(`[factory] Claude Agent session ${sessionId}: saving resume state failed`, error),
          );
      },
    });
    return session;
  }

  commands(): SessionCommands {
    const notFound: CommandResult = { ok: false, reason: 'session_not_found' };
    return {
      send: async (sessionId, input, request) => {
        const session = await this.open(sessionId, request.context);
        if (!session) return notFound;
        await session.send(input);
        return { ok: true };
      },
      abort: async (sessionId, request) => {
        const session = await this.open(sessionId, request.context);
        if (!session) return notFound;
        await session.abort();
        return { ok: true };
      },
      // Claude Agent sessions ask nothing of the human yet; Factory's interactions land with its tools.
      answer: async (sessionId, _target, _response, request) =>
        (await this.open(sessionId, request.context))
          ? { ok: false, reason: 'not_pending', message: 'no_pending_interaction' }
          : notFound,
      setModel: async (sessionId, model, request) => {
        const session = await this.open(sessionId, request.context);
        if (!session) return notFound;
        await session.setModel(model.modelId);
        await this.#deps.sessions.setModel(sessionId, model.modelId);
        return { ok: true };
      },
    };
  }

  async shutdown(): Promise<void> {
    const sessions = await Promise.allSettled(this.#live.values());
    this.#live.clear();
    await Promise.allSettled(
      sessions.flatMap(result => (result.status === 'fulfilled' && result.value ? [result.value.close()] : [])),
    );
  }
}

/**
 * Sends each command to the runtime its session runs on. Sessions with no runtime record run on
 * `fallback` (Mastra Code).
 */
export function routeSessionCommands(options: {
  sessions: { get(sessionId: string): Promise<AgentSessionRecord | undefined> };
  runtimes: Record<string, SessionCommands>;
  fallback: SessionCommands;
}): SessionCommands {
  const target = async (sessionId: string) => {
    const record = await options.sessions.get(sessionId);
    return (record && options.runtimes[record.runtimeId]) || options.fallback;
  };
  return {
    send: async (sessionId, input, request) => (await target(sessionId)).send(sessionId, input, request),
    abort: async (sessionId, request) => (await target(sessionId)).abort(sessionId, request),
    answer: async (sessionId, at, response, request) =>
      (await target(sessionId)).answer(sessionId, at, response, request),
    setModel: async (sessionId, model, request) => (await target(sessionId)).setModel(sessionId, model, request),
  };
}
