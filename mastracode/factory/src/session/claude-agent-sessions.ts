// fork(claude-agent): Factory's live Claude Agent sessions.
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SessionPublisher } from '@factory/agent-runtime';
import type {
  CommandResult,
  FactoryToolContext,
  InteractionBroker,
  InteractionRecord,
  InteractionResponse,
  SessionCommands,
  SessionEventHub,
  SendInput,
} from '@factory/agent-runtime';
import {
  CLAUDE_AGENT_RUNTIME_ID,
  ClaudeAgentSession,
  claudeProcessEnv,
  writeSkillsPlugin,
} from '@factory/runtime-claude-agent';
import type { ClaudeAgentFactoryTools, ClaudeAgentSkills, QueryFn } from '@factory/runtime-claude-agent';
import type { RequestContext } from '@mastra/core/request-context';

import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';
import { factorySkillsOf } from './claude-agent-skills.js';
import {
  INTERACTIVE_TOOLS,
  claudeAgentToolDefs,
  localSessionWorkspace,
  runMastraTool,
  toolIdentity,
} from './claude-agent-tools.js';
import type { MastraTools } from './claude-agent-tools.js';
import type { ClaudeAgentWorkspace } from './claude-agent-workspace.js';

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
  workspace(
    sessionId: string,
    requestContext: unknown,
  ): Promise<Pick<ClaudeAgentWorkspace, 'cwd' | 'env'> & Partial<ClaudeAgentWorkspace>>;
  /**
   * Factory's tools for one turn, exactly as a Mastra Code session gets them (`extraTools`), built
   * from the turn's request context. Without it the session has only Claude Code's own tools.
   */
  tools?(requestContext: RequestContext): Promise<MastraTools>;
  /**
   * Where `ask_user` and `submit_plan` wait for the human. Without it those two tools are not
   * offered: a question nobody can answer would hang the turn.
   */
  interactions?: InteractionBroker;
  /** Factory's instructions for every Claude Agent session. */
  instructions?: string;
  /** Claude Code's own home directory (see `claudeAgentHome`); created on first use. */
  home?: string;
  hostEnv?: Record<string, string | undefined>;
  query?: QueryFn;
}

/**
 * Where Claude Code keeps its config, transcripts and login for Factory sessions: apart from the
 * operator's own `~/.claude`, so their skills, plugins, memory and connectors never reach a session.
 * `FACTORY_CLAUDE_AGENT_HOME` overrides the default.
 */
export function claudeAgentHome(env: Record<string, string | undefined> = process.env): string {
  return env.FACTORY_CLAUDE_AGENT_HOME?.trim() || join(homedir(), '.mastracode', 'web', 'claude-agent-home');
}

/**
 * Opens (or resumes) a session's Claude Code on first use, keeps one per session in this process,
 * and persists Claude's resume state whenever it changes so a restart picks the conversation up.
 */
export class ClaudeAgentSessions {
  readonly #deps: ClaudeAgentSessionsDeps;
  readonly #live = new Map<string, Promise<ClaudeAgentSession | undefined>>();
  /** The host request context each open run was sent with, by run id. */
  readonly #runContexts = new Map<string, unknown>();

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
    const workspace = await this.#deps.workspace(sessionId, requestContext);
    const { cwd, env } = workspace;
    const home = this.#deps.home;
    if (home) await mkdir(home, { recursive: true, mode: 0o700 });
    const publisher = new SessionPublisher(this.#deps.hub, sessionId, {
      onError: error => console.warn(`[factory] Claude Agent session ${sessionId}: storing events failed`, error),
    });
    const factoryTools = await this.#factoryTools(sessionId, workspace, requestContext);
    const skills = await this.#skills(sessionId, workspace);
    let savedState = JSON.stringify(record.runtimeState ?? {});
    const resume = (record.runtimeState as { claudeSessionId?: string } | undefined)?.claudeSessionId;
    const session: ClaudeAgentSession = new ClaudeAgentSession({
      sessionId,
      cwd,
      env: claudeProcessEnv(this.#deps.hostEnv ?? process.env, env, home ? { home } : {}),
      ...(record.modelId ? { model: record.modelId } : {}),
      ...(resume ? { resume } : {}),
      ...(this.#deps.instructions ? { instructions: this.#deps.instructions } : {}),
      ...(this.#deps.query ? { query: this.#deps.query } : {}),
      ...(factoryTools ? { factoryTools: factoryTools.tools } : {}),
      ...(skills ? { skills } : {}),
      emit: event => {
        publisher.emit(event);
        if (event.type === 'run.ended') {
          this.#runContexts.delete(event.runId);
          factoryTools?.endRun(event.runId);
        }
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

  /**
   * The session's Factory tools. Which tools Claude Code lists is decided when it starts, from the
   * opening turn; each call then runs the tool as built for the call's own turn, so the turn's caller,
   * its interactive marker and the card's current phase apply, as in Mastra Code.
   */
  async #factoryTools(
    sessionId: string,
    workspace: Awaited<ReturnType<ClaudeAgentSessionsDeps['workspace']>>,
    openContext: unknown,
  ): Promise<{ tools: ClaudeAgentFactoryTools; endRun(runId: string): void } | undefined> {
    const build = this.#deps.tools;
    const contextFor = workspace.requestContext;
    if (!build || !contextFor) return undefined;
    const broker = this.#deps.interactions;
    const interactive = broker ? INTERACTIVE_TOOLS : {};
    // The tools close over the context they were built with; calls run with that same context.
    const forContext = async (hostContext: unknown) => {
      const requestContext = contextFor(hostContext);
      return { requestContext, tools: { ...interactive, ...(await build(requestContext)) } };
    };
    const opening = forContext(openContext);
    const perRun = new Map<string, ReturnType<typeof forContext>>();
    const turn = (runId: string | undefined) => {
      if (!runId || !this.#runContexts.has(runId)) return opening;
      let built = perRun.get(runId);
      if (!built) {
        built = forContext(this.#runContexts.get(runId));
        perRun.set(runId, built);
      }
      return built;
    };
    const callRuns = new Map<string, string | undefined>();
    const sessionWorkspace = localSessionWorkspace(workspace);
    const defs = claudeAgentToolDefs((await opening).tools, async (name, input, ctx: FactoryToolContext) => {
      const runId = callRuns.get(ctx.callId);
      callRuns.delete(ctx.callId);
      const current = await turn(runId);
      const tool = current.tools[name];
      if (!tool) throw new Error(`Factory tool ${name} is not available in this turn`);
      return runMastraTool(name, tool, input, ctx, {
        requestContext: current.requestContext,
        cwd: workspace.cwd,
        sessionId,
      });
    });
    return {
      tools: {
        defs,
        context: async call => {
          callRuns.set(call.callId, call.runId);
          const { requestContext } = await turn(call.runId);
          return {
            sessionId,
            callId: call.callId,
            ...toolIdentity(requestContext),
            workspace: sessionWorkspace,
            signal: call.signal,
            interact: request => {
              if (!broker) throw new Error('Nobody can answer questions in this session');
              return broker.request(sessionId, request, { callId: call.callId, signal: call.signal });
            },
          };
        },
      },
      endRun: runId => perRun.delete(runId),
    };
  }

  /** Factory's skills for the session, written as a plugin under Claude Code's home. */
  async #skills(
    sessionId: string,
    workspace: Awaited<ReturnType<ClaudeAgentSessionsDeps['workspace']>>,
  ): Promise<ClaudeAgentSkills | undefined> {
    const home = this.#deps.home;
    if (!home || !workspace.skills) return undefined;
    const skills = await factorySkillsOf(workspace.skills);
    if (!skills.length) return undefined;
    return writeSkillsPlugin(join(home, 'factory-skills', encodeURIComponent(sessionId)), skills);
  }

  /** Start a turn, remembering the request it came with so its tool calls act as that caller. */
  async #send(session: ClaudeAgentSession, input: SendInput, context: unknown): Promise<void> {
    // Set before Claude Code reads the turn: `send` queues it and returns without yielding to it.
    const { runId } = await session.send(input);
    this.#runContexts.set(runId, context);
  }

  commands(): SessionCommands {
    const notFound: CommandResult = { ok: false, reason: 'session_not_found' };
    const notPending: CommandResult = { ok: false, reason: 'not_pending', message: 'no_pending_interaction' };
    return {
      send: async (sessionId, input, request) => {
        const session = await this.open(sessionId, request.context);
        if (!session) return notFound;
        await this.#send(session, input, request.context);
        return { ok: true };
      },
      abort: async (sessionId, request) => {
        const session = await this.open(sessionId, request.context);
        if (!session) return notFound;
        // A question or plan the turn waits on goes with it.
        await this.#deps.interactions?.cancelSession(sessionId, 'aborted');
        await session.abort();
        return { ok: true };
      },
      answer: async (sessionId, target, response, request) => {
        const session = await this.open(sessionId, request.context);
        if (!session) return notFound;
        const broker = this.#deps.interactions;
        if (!broker) return notPending;
        const pending = (await broker.listPending({ sessionId })).find(record =>
          target.interactionId ? record.id === target.interactionId : record.callId === target.callId,
        );
        if (!pending) return notPending;
        if (pending.request.kind !== response.kind) {
          return { ok: false, reason: 'invalid', message: `expected a ${pending.request.kind} answer` };
        }
        const outcome = await broker.resolve(pending.id, response, {
          resolvedBy: toolIdentity(contextOf(request.context)).userId,
        });
        if (outcome.status === 'not_pending') return notPending;
        // Nobody waits any more (the server restarted while the human decided): Claude Code's call
        // is gone, so the answer reaches the conversation as a message instead.
        if (outcome.status === 'queued')
          await this.#send(session, { text: lateAnswer(pending, response) }, request.context);
        return { ok: true };
      },
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

/** A request context's `get`, or none (tests and hosts may pass anything). */
function contextOf(context: unknown): RequestContext {
  return (
    context && typeof (context as { get?: unknown }).get === 'function' ? context : { get: () => undefined }
  ) as RequestContext;
}

/** An answer whose tool call no longer waits, told to Claude as a message. */
export function lateAnswer(record: InteractionRecord, response: InteractionResponse): string {
  if (response.kind === 'question' && record.request.kind === 'question') {
    const answer = Array.isArray(response.answer) ? response.answer.join(', ') : response.answer;
    return `Earlier you asked: "${record.request.question}". That call was interrupted before the answer arrived. The answer is: ${answer}`;
  }
  if (response.kind === 'plan_approval' && record.request.kind === 'plan_approval') {
    const plan = `\`${record.request.planPath}\``;
    if (response.action === 'approved') {
      return `Your plan ${plan} was approved after its submit_plan call was interrupted. Proceed with implementation following the approved plan.`;
    }
    return response.feedback
      ? `Your plan ${plan} was not approved. Feedback: ${response.feedback}\n\nRevise the plan and submit it again with submit_plan.`
      : `Your plan ${plan} was not approved. Wait for the person to send revision instructions.`;
  }
  return `A tool call was interrupted before its answer arrived: ${JSON.stringify(response)}`;
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
