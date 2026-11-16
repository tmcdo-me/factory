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
  FACTORY_SKILLS_PLUGIN,
  claudeProcessEnv,
  skillKickoffText,
  writeSkillsPlugin,
} from '@factory/runtime-claude-agent';
import type {
  ClaudeAgentFactoryTools,
  ClaudeAgentRuntimeState,
  ClaudeAgentSkills,
  ClaudeTurnInput,
  ClaudeTurnNotice,
  QueryFn,
} from '@factory/runtime-claude-agent';
import type { RequestContext } from '@mastra/core/request-context';

import { FactoryDispatchError } from '../rules/dispatch-errors.js';
import type { FactoryRuntimeSessions, RuntimeRunEnd } from '../rules/runtime-sessions.js';
import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';
import { withWorkItemDescription } from '../work-items/description-context.js';
import type { ClaudeAgentContext, ClaudeAgentContextBlock } from './claude-agent-context.js';
import type { CheckoutPosture } from './claude-agent-posture.js';
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

/** A session id usable as one folder name: no separators, no `.`/`..`. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
  /** What each turn tells Claude about the session's card and phase, when that changed. */
  context?: ClaudeAgentContext;
  /**
   * Whether the session's checkout holds content nobody vetted (see `claudeAgentCheckoutPosture`).
   * Read whenever Claude Code starts; an untrusted checkout loads none of its own settings. Without
   * it every checkout is trusted.
   */
  checkout?(sessionId: string): Promise<CheckoutPosture>;
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
  /** Per open session: what it was opened with, and what Factory told it last. */
  readonly #opened = new Map<string, OpenSession>();
  /** Factory messages that wait for the session's next turn (in memory, at most `MAX_WAITING_MESSAGES`). */
  readonly #notes = new Map<string, ClaudeTurnNotice[]>();
  /** How many waiting messages were dropped since the session last heard, by session. */
  readonly #dropped = new Map<string, number>();
  /** Resume state of a Claude Code just closed to restart, so the restart resumes it even before it is stored. */
  readonly #resume = new Map<string, ClaudeAgentRuntimeState>();
  /** Context last told to each session, by context id. Kept across reopens: the conversation resumes. */
  readonly #told = new Map<string, Map<string, ClaudeAgentContextBlock>>();
  /** Who waits for a run to end, by run id. */
  readonly #runEnds = new Map<string, (end: RuntimeRunEnd) => void>();
  /** Who waits for a session to have no run in flight. */
  readonly #idle = new Map<string, (() => void)[]>();
  /**
   * Runs started in this process, as `sessionId run id`. A run lives and dies with this process's
   * Claude Code, so this is the whole answer to "did this kickoff land in a run that may still be
   * going": after a restart the run is gone, and the kickoff is owed again.
   */
  readonly #started = new Set<string>();
  /** Answers plan approvals on the board's behalf, by the board run's id, while it says so. */
  readonly #autoApprove = new Map<string, () => boolean>();

  constructor(deps: ClaudeAgentSessionsDeps) {
    this.#deps = deps;
  }

  /** The live session, opening it if this session runs on Claude Agent. */
  open(sessionId: string, requestContext: unknown): Promise<ClaudeAgentSession | undefined> {
    const existing = this.#live.get(sessionId);
    if (existing) return existing;
    const opening = this.#openSession(sessionId, requestContext).catch(error => {
      this.#live.delete(sessionId);
      throw error;
    });
    this.#live.set(sessionId, opening);
    return opening;
  }

  async #openSession(sessionId: string, requestContext: unknown): Promise<ClaudeAgentSession | undefined> {
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
    const skills = await this.#skills(sessionId, workspace, requestContext);
    const untrusted = (await this.#posture(sessionId)) === 'untrusted';
    // A restart carries the state of the Claude Code it replaces: saving it is fire-and-forget.
    const runtimeState = this.#resume.get(sessionId) ?? (record.runtimeState as ClaudeAgentRuntimeState | undefined);
    this.#resume.delete(sessionId);
    let savedState = JSON.stringify(record.runtimeState ?? {});
    const resume = runtimeState?.claudeSessionId;
    const session: ClaudeAgentSession = new ClaudeAgentSession({
      sessionId,
      cwd,
      ...(untrusted ? { untrustedCheckout: true } : {}),
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
          this.#settleRun(event.runId, { reason: event.reason, ...(event.error ? { error: event.error } : {}) });
          if (session.status() !== 'running') {
            for (const wake of this.#idle.get(sessionId)?.splice(0) ?? []) wake();
          }
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
    this.#opened.set(sessionId, {
      session,
      untrusted,
      skills: skills?.names ?? [],
      ...(workspace.requestContext ? { requestContext: workspace.requestContext } : {}),
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
            interact: async request => {
              if (!broker) throw new Error('Nobody can answer questions in this session');
              // A board that approves this phase's plans answers for the person.
              if (request.kind === 'plan_approval' && call.runId && this.#autoApprove.get(call.runId)?.()) {
                return { kind: 'plan_approval', action: 'approved' } as never;
              }
              // A board run that waits on a person is parked, as a suspended Mastra Code run ends: the
              // dispatcher stops watching it, and the turn goes on once the person answers.
              if (call.runId) this.#settleRun(call.runId, { reason: 'awaiting_interaction' });
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
    hostContext: unknown,
  ): Promise<ClaudeAgentSkills | undefined> {
    const home = this.#deps.home;
    if (!home || !workspace.skills) return undefined;
    const skills = await factorySkillsOf(workspace.skills, workspace.requestContext?.(hostContext));
    if (!skills.length) return undefined;
    // The folder is deleted and rewritten on every start, so its name must be one plain segment.
    if (!SAFE_SEGMENT.test(sessionId))
      throw new Error(`Session id ${JSON.stringify(sessionId)} is not a safe folder name`);
    return writeSkillsPlugin(join(home, 'factory-skills', sessionId), skills);
  }

  /**
   * Start a turn, remembering the request it came with so its tool calls act as that caller. The
   * turn carries what Factory has to tell the session first: messages that waited for it, and the
   * card's context where it changed since the session last heard.
   */
  async #send(session: ClaudeAgentSession, input: SendInput | ClaudeTurnInput, context: unknown): Promise<string> {
    const told = await this.#context(session.id, context);
    const dropped = this.#dropped.get(session.id) ?? 0;
    const notes = [
      ...(dropped
        ? [
            factoryMessage(
              `${dropped} earlier Factory message${dropped === 1 ? ' was' : 's were'} dropped before this session read ${dropped === 1 ? 'it' : 'them'}. Check the card and its sources for anything you missed.`,
              'factory',
            ),
          ]
        : []),
      ...(this.#notes.get(session.id) ?? []),
    ];
    this.#notes.delete(session.id);
    this.#dropped.delete(session.id);
    const extra = (input as ClaudeTurnInput).context ?? [];
    const turn: ClaudeTurnInput = { ...input, context: [...notes, ...told.map(contextNotice), ...extra] };
    // Set before Claude Code reads the turn: `send` queues it and returns without yielding to it.
    const { runId } = await session.send(turn);
    this.#runContexts.set(runId, context);
    this.#started.add(`${session.id} ${runId}`);
    const known = this.#told.get(session.id) ?? new Map<string, ClaudeAgentContextBlock>();
    for (const block of told) known.set(block.id, block);
    this.#told.set(session.id, known);
    return runId;
  }

  /** Tell whoever waits on a run how it ended (or that it waits on a person). */
  #settleRun(runId: string, end: RuntimeRunEnd): void {
    this.#runEnds.get(runId)?.(end);
    this.#runEnds.delete(runId);
  }

  /** The card's context that changed since the session last heard it. */
  async #context(sessionId: string, hostContext: unknown): Promise<ClaudeAgentContextBlock[]> {
    const produce = this.#deps.context;
    const requestContext = this.#opened.get(sessionId)?.requestContext;
    if (!produce || !requestContext) return [];
    try {
      return await produce(requestContext(hostContext), this.#told.get(sessionId) ?? new Map());
    } catch (error) {
      console.warn(`[factory] Claude Agent session ${sessionId}: reading its card's context failed`, error);
      return [];
    }
  }

  /** The session's checkout posture; unknown is untrusted. */
  async #posture(sessionId: string): Promise<CheckoutPosture> {
    if (!this.#deps.checkout) return 'trusted';
    try {
      return await this.#deps.checkout(sessionId);
    } catch {
      return 'untrusted';
    }
  }

  /**
   * The session, ready for a turn. Claude Code fixes its tools, skills and settings when it starts,
   * so it starts again (resuming the conversation) when its checkout's posture changed since, and,
   * with `restartIdle`, whenever it is idle: a board run's phase decides its tools and skills. A
   * Claude Code started trusted never takes a turn once its checkout is untrusted.
   */
  async #ready(
    sessionId: string,
    requestContext: unknown,
    options: { restartIdle?: boolean } = {},
  ): Promise<ClaudeAgentSession | undefined> {
    const live = this.#opened.get(sessionId);
    if (live && this.#live.has(sessionId)) {
      const untrusted = (await this.#posture(sessionId)) === 'untrusted';
      const idle = live.session.status() !== 'running';
      if (idle && (options.restartIdle || untrusted !== live.untrusted)) {
        this.#resume.set(sessionId, live.session.runtimeState());
        this.#live.delete(sessionId);
        this.#opened.delete(sessionId);
        await live.session.close();
      } else if (untrusted && !live.untrusted) {
        throw new FactoryDispatchError(
          'session_unavailable',
          `Session ${sessionId} now works an untrusted checkout; it takes turns again once its run ends.`,
        );
      }
    }
    return this.open(sessionId, requestContext);
  }

  /** Hold a Factory message for the session's next turn, dropping the oldest past the cap. */
  #hold(sessionId: string, notice: ClaudeTurnNotice): void {
    const notes = [...(this.#notes.get(sessionId) ?? []), notice];
    const over = notes.length - MAX_WAITING_MESSAGES;
    if (over > 0) {
      notes.splice(0, over);
      this.#dropped.set(sessionId, (this.#dropped.get(sessionId) ?? 0) + over);
    }
    this.#notes.set(sessionId, notes);
  }

  /** Board runs on Claude Agent sessions, for the dispatcher. */
  runtimeSessions(): FactoryRuntimeSessions {
    return {
      runs: async sessionId => {
        try {
          return (await this.#deps.sessions.get(sessionId))?.runtimeId === CLAUDE_AGENT_RUNTIME_ID;
        } catch (error) {
          // Unknown runtime: Mastra Code, the runtime of every session without a record.
          console.warn(`[factory] Session ${sessionId}: reading its runtime failed; treating it as Mastra Code`, error);
          return false;
        }
      },
      hasRun: async (sessionId, runId) => this.#started.has(`${sessionId} ${runId}`),
      isRunning: sessionId => this.#opened.get(sessionId)?.session.status() === 'running',
      awaitsPerson: async sessionId => ((await this.#deps.interactions?.listPending({ sessionId })) ?? []).length > 0,
      idle: sessionId => {
        if (this.#opened.get(sessionId)?.session.status() !== 'running') return Promise.resolve();
        return new Promise<void>(resolve => {
          const waiting = this.#idle.get(sessionId) ?? [];
          waiting.push(resolve);
          this.#idle.set(sessionId, waiting);
        });
      },
      kickoff: async (sessionId, kickoff, requestContext) => {
        const session = await this.#ready(sessionId, requestContext, { restartIdle: true });
        if (!session) {
          throw new FactoryDispatchError('session_unavailable', `Session ${sessionId} does not run on Claude Agent.`);
        }
        const skill = kickoff.skill;
        if (skill && !this.#opened.get(sessionId)?.skills.includes(`${FACTORY_SKILLS_PLUGIN}:${skill.name}`)) {
          throw new FactoryDispatchError(
            'run_configuration_invalid',
            `Skill ${skill.name} is not available to this Claude Agent session.`,
          );
        }
        const text = withWorkItemDescription(
          skill ? skillKickoffText(skill.name, skill) : (kickoff.prompt ?? ''),
          kickoff.description,
        );
        const ended = new Promise<RuntimeRunEnd>(resolve => this.#runEnds.set(kickoff.runId, resolve));
        // Only this run's plans: a person's own submit_plan in another turn always waits for them.
        if (kickoff.autoApprovePlan) this.#autoApprove.set(kickoff.runId, kickoff.autoApprovePlan);
        void ended.then(() => this.#autoApprove.delete(kickoff.runId));
        try {
          await this.#send(
            session,
            {
              runId: kickoff.runId,
              text,
              ...(kickoff.preface ? { context: [factoryMessage(kickoff.preface, 'stage-transition')] } : {}),
              ...(skill ? { notice: { kind: 'reactive', tag: 'skill', attributes: { name: skill.name } } } : {}),
            },
            requestContext,
          );
        } catch (error) {
          this.#runEnds.delete(kickoff.runId);
          this.#autoApprove.delete(kickoff.runId);
          throw error;
        }
        return { ended };
      },
      message: async (sessionId, message, requestContext) => {
        const notice = factoryMessage(message.text, message.source);
        if (!message.wake) {
          this.#hold(sessionId, notice);
          return;
        }
        const session = await this.#ready(sessionId, requestContext);
        if (!session) {
          throw new FactoryDispatchError('session_unavailable', `Session ${sessionId} does not run on Claude Agent.`);
        }
        const { text, ...shown } = notice;
        await this.#send(session, { text, notice: shown }, requestContext);
      },
      abort: async (sessionId, requestContext) => {
        await this.commands().abort(sessionId, { context: requestContext });
      },
    };
  }

  commands(): SessionCommands {
    const notFound: CommandResult = { ok: false, reason: 'session_not_found' };
    const notPending: CommandResult = { ok: false, reason: 'not_pending', message: 'no_pending_interaction' };
    return {
      send: async (sessionId, input, request) => {
        const session = await this.#ready(sessionId, request.context);
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
    this.#opened.clear();
    await Promise.allSettled(
      sessions.flatMap(result => (result.status === 'fulfilled' && result.value ? [result.value.close()] : [])),
    );
  }
}

/** Factory messages a session holds for its next turn; past this the oldest are dropped. */
const MAX_WAITING_MESSAGES = 20;

interface OpenSession {
  session: ClaudeAgentSession;
  /** Started for an untrusted checkout. */
  untrusted: boolean;
  /** The skills it was started with (`factory:<name>`). */
  skills: readonly string[];
  /** Factory's request context for a turn sent with a host context. */
  requestContext?: (hostContext: unknown) => RequestContext;
}

function contextNotice({ kind, tag, text, attributes }: ClaudeAgentContextBlock): ClaudeTurnNotice {
  return { kind, tag, text, ...(attributes ? { attributes } : {}) };
}

/** Something Factory tells the session, shown as Factory's in the transcript. */
function factoryMessage(text: string, source: string): ClaudeTurnNotice {
  return { kind: 'reactive', tag: 'factory-message', text, attributes: { source } };
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
    let record: AgentSessionRecord | undefined;
    try {
      record = await options.sessions.get(sessionId);
    } catch (error) {
      console.warn(`[factory] Session ${sessionId}: reading its runtime failed; sending to Mastra Code`, error);
    }
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
