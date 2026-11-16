// fork(claude-agent): Factory's live Claude Agent sessions.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { SessionPublisher } from '@factory/agent-runtime';
import type {
  CommandResult,
  FactoryEvent,
  FactoryToolContext,
  InteractionBroker,
  InteractionRecord,
  InteractionResponse,
  SessionCommands,
  SessionEventHub,
  SendInput,
} from '@factory/agent-runtime';
import {
  BASH_SANDBOX_WRITABLE_HOME_DIRS,
  CLAUDE_AGENT_RUNTIME_ID,
  ClaudeAgentSession,
  FACTORY_SKILLS_PLUGIN,
  claudeProcessEnv,
  plainTextQuestion,
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
  WaitingVerdict,
} from '@factory/runtime-claude-agent';
import type { RequestContext } from '@mastra/core/request-context';

import { FactoryDispatchError } from '../rules/dispatch-errors.js';
import type { FactoryRuntimeSessions, RuntimeRunEnd, RuntimeRunUsage } from '../rules/runtime-sessions.js';
import type { AgentMessage, AgentMessageStore } from '../storage/domains/agent-messages/base.js';
import { InMemoryAgentMessages } from '../storage/domains/agent-messages/memory.js';
import type { AgentSessionRecord } from '../storage/domains/agent-sessions/base.js';
import { withWorkItemDescription } from '../work-items/description-context.js';
import type { ClaudeAgentContext, ClaudeAgentContextBlock } from './claude-agent-context.js';
import type { ClaudeAgentHost } from './claude-agent-host.js';
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
import { answersWithDecision, interactionToolName } from './pending-interactions.js';

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
    /** fork(claude-agent): Claude Code's Bash sandbox is on, so a remote sandbox must be ready for it. */
    open?: { bashSandbox?: boolean },
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
  /**
   * Told each Factory tool call's result before Claude gets it, as Mastra Code's processors and
   * post-tool observers see a finished call: board rules, plan approvals, audits. Never blocks the
   * result: a failure is logged.
   */
  onToolResult?(result: ClaudeAgentToolResult): Promise<void>;
  /**
   * Told each of Claude Code's own shell commands once it finished (`Bash`), as Mastra Code's
   * post-tool observers see `execute_command`: git audits, pull requests a command opened.
   */
  onShellResult?(result: ClaudeAgentShellResult): Promise<void>;
  /** Claude Code's own home directory (see `claudeAgentHome`); created on first use. */
  home?: string;
  /**
   * Whether this process may run Claude Agent sessions: one process sharing the database does (see
   * `claudeAgentHostLease`). Without it every process may.
   */
  host?: Pick<ClaudeAgentHost, 'held' | 'onLost'>;
  /**
   * Where Factory's messages wait for a session's next turn, so a restart keeps them, and what each
   * session was told, so it can answer a message. In this process's memory without it.
   */
  messages?: AgentMessageStore;
  hostEnv?: Record<string, string | undefined>;
  query?: QueryFn;
  /** fork(claude-agent): stop an idle Claude Code after this long (see `claudeAgentIdleCloseMs`). */
  idleCloseMs?: number;
  /**
   * fork(claude-agent): run trusted sessions' Bash in Claude Code's own sandbox (see
   * `claudeAgentBashSandbox`); untrusted sessions always do.
   */
  bashSandbox?: boolean;
  /** fork(claude-agent): how long background work alone may keep Claude Code running (see `claudeAgentBackgroundMaxMs`). */
  backgroundMaxMs?: number;
  /**
   * fork(claude-agent): decides whether a turn's last message waits on a person, when the cheap check
   * (`plainTextQuestion`) can't tell: Claude Code itself, one turn with no tools
   * (`judgeWaitingOnPerson`). Without it, a turn that asks in plain text is re-kicked, as before.
   */
  waitingJudge?(input: { objective: string; text: string }): Promise<WaitingVerdict | undefined>;
}

/**
 * fork(claude-agent): how long background work (a dev server, a `--watch`, a stuck subagent) may keep
 * an otherwise idle Claude Code running before it is stopped anyway.
 * `FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS` overrides the default (60 minutes).
 */
export function claudeAgentBackgroundMaxMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : 60 * 60_000;
}

/**
 * fork(claude-agent): a Claude Code held by background work is stopped at this age regardless: the
 * GitHub token it started with was at most 10 minutes old (Factory re-mints older ones) and lasts an
 * hour, so this leaves a 5-minute margin.
 */
const CLAUDE_AGENT_PROCESS_DEADLINE_MS = 45 * 60_000;

/**
 * fork(claude-agent): whether Claude Agent sessions run their Bash commands in Claude Code's own
 * sandbox, which keeps Claude's credential from them. On by default; `FACTORY_CLAUDE_AGENT_BASH_SANDBOX=0`
 * (or `false`, `off`, `no`) turns it off for trusted sessions. An untrusted checkout (a pull
 * request under review) always runs sandboxed. It needs the sandbox's dependencies (bubblewrap
 * and socat on Linux; a Sprite gets them installed) and confines what commands may write (see
 * `claudeAgentBashSandbox` in `@factory/runtime-claude-agent`).
 */
export function claudeAgentBashSandbox(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.FACTORY_CLAUDE_AGENT_BASH_SANDBOX?.trim() ?? '');
}

/**
 * fork(claude-agent): files on this host that a Claude Agent session's commands must not read,
 * because they hold Claude's credential: the env files Factory's server was started with (varlock
 * loads `mastracode/web/.env`, which is where `CLAUDE_CODE_OAUTH_TOKEN` usually lives), found
 * from the server's entry point and working directory upwards; the operator's own Claude login
 * (`~/.claude/.credentials.json` on Linux); and `FACTORY_CLAUDE_AGENT_BASH_DENY_READ`
 * (comma-separated paths) for anywhere else the operator keeps it. Claude's file tools (Read, Grep,
 * Edit, …) are refused them in every session, and with the Bash sandbox its commands too; the sandbox
 * lets commands read everything else on this machine.
 */
export function claudeAgentHostSecretFiles(
  env: Record<string, string | undefined> = process.env,
  from: readonly (string | undefined)[] = [process.argv[1] ? dirname(process.argv[1]) : undefined, process.cwd()],
): string[] {
  const files = new Set<string>([join(homedir(), '.claude', '.credentials.json')]);
  for (const start of from) {
    if (!start || !isAbsolute(start)) continue;
    for (let dir = start; ; dir = dirname(dir)) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        // Unreadable: nothing to deny there.
      }
      for (const name of names) if (/^\.env(\..+)?$/.test(name)) files.add(join(dir, name));
      if (dirname(dir) === dir) break;
    }
  }
  for (const path of env.FACTORY_CLAUDE_AGENT_BASH_DENY_READ?.split(',') ?? []) {
    if (isAbsolute(path.trim())) files.add(path.trim());
  }
  return [...files];
}

/**
 * fork(claude-agent): how long a Claude Code may sit idle before it is stopped; the next turn starts
 * it again, resuming from its transcript. Frees the process, and the Sprite it keeps awake.
 * `FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS` overrides the default (10 minutes); `0` keeps it running.
 */
export function claudeAgentIdleCloseMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60_000;
}

/**
 * fork(claude-agent): a Claude Code that ran this long is restarted once its run ends, so it never
 * holds a GitHub token past its life: Factory re-mints tokens once they are 30 minutes old, and
 * they last an hour.
 */
const CLAUDE_AGENT_RECYCLE_AFTER_MS = 20 * 60_000;

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
  /** Factory messages that wait for each session's next turn (at most `MAX_WAITING_MESSAGES`), and what it was told. */
  readonly #messages: AgentMessageStore;
  /** When the last message was kept, so two kept in one millisecond keep their order. */
  #lastMessageAt = 0;
  /** Resume state of a Claude Code just closed to restart, so the restart resumes it even before it is stored. */
  readonly #resume = new Map<string, ClaudeAgentRuntimeState>();
  /** Context last told to each session, by context id. Kept across reopens: the conversation resumes. */
  readonly #told = new Map<string, Map<string, ClaudeAgentContextBlock>>();
  /** Who waits for a run to end, by run id. */
  readonly #runEnds = new Map<string, (end: RuntimeRunEnd) => void>();
  /** Token usage of the runs someone waits on, by run id, until they end. */
  readonly #runUsage = new Map<string, RuntimeRunUsage[]>();
  /** Who waits for a session to have no run in flight. */
  readonly #idle = new Map<string, (() => void)[]>();
  /**
   * Runs started in this process, as `sessionId run id`. A run lives and dies with this process's
   * Claude Code, so this is the whole answer to "did this kickoff land in a run that may still be
   * going": after a restart the run is gone, and the kickoff is owed again.
   */
  readonly #started = new Set<string>();
  /** Sessions whose checkout was ever untrusted; it stays untrusted (also kept on the session record). */
  readonly #sticky = new Set<string>();
  /** Runs a board kickoff started, while they are open. */
  readonly #boardRuns = new Set<string>();
  /** The interaction a session's run waits on, by session: the run and the tool call that asked. */
  readonly #parked = new Map<string, { runId: string; callId: string }>();
  /** The write of each session record's state in flight, which the next write waits for. */
  readonly #stateWrites = new Map<string, Promise<void>>();
  /** Answers plan approvals on the board's behalf, by the board run's id, while it says so. */
  readonly #autoApprove = new Map<string, () => boolean>();
  /** fork(claude-agent): the text of the last assistant message of each session's latest turn. */
  readonly #lastReply = new Map<string, { messageId?: string; text: string }>();
  /** fork(claude-agent): a board run parked on a question its turn asked in plain text, by session. */
  readonly #awaitingReply = new Map<string, AwaitingReply>();

  constructor(deps: ClaudeAgentSessionsDeps) {
    this.#deps = deps;
    this.#messages = deps.messages ?? new InMemoryAgentMessages();
    // Another process runs Claude Agent sessions now: stop this one's, and open no more (`#openSession`).
    deps.host?.onLost(() => void this.#stopAll(HOST_LOST_NOTICE));
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
    if (this.#deps.host && !(await this.#deps.host.held())) {
      throw new FactoryDispatchError(
        'session_unavailable',
        `Session ${sessionId} runs on Claude Agent, which another Factory process sharing this database runs.`,
      );
    }
    // An untrusted checkout always runs Claude's Bash sandboxed; a trusted one unless turned off.
    const untrusted = (await this.#posture(sessionId)) === 'untrusted';
    const bashSandbox = untrusted || (this.#deps.bashSandbox ?? claudeAgentBashSandbox());
    const workspace = await this.#deps.workspace(sessionId, requestContext, { bashSandbox });
    const { cwd, env, launch } = workspace;
    // fork(claude-agent): Claude Code runs on this host, or inside the session's sandbox (`launch`).
    const home = launch ? launch.home : this.#deps.home;
    if (home && !launch) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      // On Linux a sandbox rule for a missing path has no effect; in a sandbox the launch makes them.
      if (bashSandbox) {
        await Promise.all(BASH_SANDBOX_WRITABLE_HOME_DIRS.map(dir => mkdir(join(home, dir), { recursive: true })));
      }
    }
    const watchShell = this.#shellWatcher(sessionId, workspace);
    const publisher = new SessionPublisher(this.#deps.hub, sessionId, {
      onError: error => console.warn(`[factory] Claude Agent session ${sessionId}: storing events failed`, error),
    });
    const factoryTools = await this.#factoryTools(sessionId, workspace, requestContext);
    const skills = await this.#skills(sessionId, workspace, requestContext);
    // A restart carries the state of the Claude Code it replaces: saving it is fire-and-forget.
    const runtimeState = this.#resume.get(sessionId) ?? (record.runtimeState as ClaudeAgentRuntimeState | undefined);
    this.#resume.delete(sessionId);
    let savedState = JSON.stringify(record.runtimeState ?? {});
    const resume = runtimeState?.claudeSessionId;
    const hostEnv = this.#deps.hostEnv ?? process.env;
    const envOptions = { ...(home ? { home } : {}), ...(launch?.remote ? { remote: true } : {}) };
    const freshEnv = workspace.freshEnv;
    const session: ClaudeAgentSession = new ClaudeAgentSession({
      sessionId,
      cwd,
      ...(untrusted ? { untrustedCheckout: true } : {}),
      // fork(claude-agent): read again whenever Claude Code (re)starts, so refreshed credentials reach it.
      env: freshEnv
        ? async () => claudeProcessEnv(hostEnv, await freshEnv(), envOptions)
        : claudeProcessEnv(hostEnv, env, envOptions),
      idleCloseMs: this.#deps.idleCloseMs ?? claudeAgentIdleCloseMs(),
      ...(bashSandbox ? { bashSandbox: true } : {}),
      // On this host Claude's file tools, and with the sandbox its commands, must not read the files
      // holding Claude's credential either; in a sandbox, only Claude's own saved login (always denied).
      ...(launch ? {} : { secretFiles: claudeAgentHostSecretFiles(hostEnv) }),
      recycleAfterMs: CLAUDE_AGENT_RECYCLE_AFTER_MS,
      processDeadlineMs: CLAUDE_AGENT_PROCESS_DEADLINE_MS,
      backgroundMaxMs: this.#deps.backgroundMaxMs ?? claudeAgentBackgroundMaxMs(),
      ...(launch?.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: launch.spawnClaudeCodeProcess } : {}),
      ...(launch?.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable } : {}),
      ...(record.modelId ? { model: record.modelId } : {}),
      ...(resume ? { resume } : {}),
      ...(this.#deps.instructions ? { instructions: this.#deps.instructions } : {}),
      ...(this.#deps.query ? { query: this.#deps.query } : {}),
      ...(factoryTools ? { factoryTools: factoryTools.tools } : {}),
      ...(skills ? { skills } : {}),
      emit: event => {
        publisher.emit(event);
        watchShell(event);
        this.#followReply(sessionId, event);
        if (event.type === 'usage' && event.runId && this.#runEnds.has(event.runId)) {
          const { inputTokens, outputTokens, cachedInputTokens, reasoningTokens } = event;
          this.#runUsage.set(event.runId, [
            ...(this.#runUsage.get(event.runId) ?? []),
            {
              inputTokens,
              outputTokens,
              ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
              ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            },
          ]);
        }
        if (event.type === 'run.ended') {
          this.#runContexts.delete(event.runId);
          factoryTools?.endRun(event.runId);
          this.#settleRun(event.runId, { reason: event.reason, ...(event.error ? { error: event.error } : {}) });
          this.#runUsage.delete(event.runId);
          this.#boardRuns.delete(event.runId);
          if (this.#parked.get(sessionId)?.runId === event.runId) this.#parked.delete(sessionId);
          if (session.status() !== 'running') {
            for (const wake of this.#idle.get(sessionId)?.splice(0) ?? []) wake();
          }
        }
        if (event.type !== 'model.changed' && event.type !== 'run.ended') return;
        const current = this.#stateOf(sessionId, session);
        const state = JSON.stringify(current);
        if (state === savedState) return;
        savedState = state;
        void this.#saveState(sessionId, async () => current, 'saving resume state');
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
    const sessionWorkspace = workspace.sessionWorkspace ?? localSessionWorkspace(workspace);
    const defs = claudeAgentToolDefs((await opening).tools, async (name, input, ctx: FactoryToolContext) => {
      const runId = callRuns.get(ctx.callId);
      callRuns.delete(ctx.callId);
      const current = await turn(runId);
      const tool = current.tools[name];
      if (!tool) throw new Error(`Factory tool ${name} is not available in this turn`);
      const observed = { sessionId, callId: ctx.callId, toolName: name, input, requestContext: current.requestContext };
      let output: unknown;
      try {
        output = await runMastraTool(name, tool, input, ctx, {
          requestContext: current.requestContext,
          cwd: workspace.cwd,
          sessionId,
          // fork(claude-agent): workspace-backed tools (git push, PRs) run in the session's sandbox.
          ...(workspace.workspace ? { workspace: workspace.workspace } : {}),
        });
      } catch (error) {
        await this.#observe({ ...observed, status: 'error', error });
        throw error;
      }
      await this.#observe({ ...observed, status: 'success', value: output });
      return output;
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
              if (call.runId) {
                this.#settleRun(call.runId, { reason: 'awaiting_interaction' });
                this.#parked.set(sessionId, { runId: call.runId, callId: call.callId });
              }
              try {
                return await broker.request(sessionId, request, { callId: call.callId, signal: call.signal });
              } finally {
                if (this.#parked.get(sessionId)?.callId === call.callId) this.#parked.delete(sessionId);
              }
            },
          };
        },
      },
      endRun: runId => perRun.delete(runId),
    };
  }

  /** Factory's skills for the session, written as a plugin under Claude Code's home (where it runs). */
  async #skills(
    sessionId: string,
    workspace: Awaited<ReturnType<ClaudeAgentSessionsDeps['workspace']>>,
    hostContext: unknown,
  ): Promise<ClaudeAgentSkills | undefined> {
    const home = workspace.launch?.home ?? this.#deps.home;
    if (!home || !workspace.skills) return undefined;
    const skills = await factorySkillsOf(workspace.skills, workspace.requestContext?.(hostContext));
    if (!skills.length) return undefined;
    // The folder is deleted and rewritten on every start, so its name must be one plain segment.
    if (!SAFE_SEGMENT.test(sessionId))
      throw new Error(`Session id ${JSON.stringify(sessionId)} is not a safe folder name`);
    return writeSkillsPlugin(join(home, 'factory-skills', sessionId), skills, workspace.launch?.files);
  }

  /**
   * Start a turn, remembering the request it came with so its tool calls act as that caller. The
   * turn carries what Factory has to tell the session first: messages that waited for it, and the
   * card's context where it changed since the session last heard.
   */
  async #send(session: ClaudeAgentSession, input: SendInput | ClaudeTurnInput, context: unknown): Promise<string> {
    const told = await this.#context(session.id, context);
    const { messages: waiting, dropped } = await this.#waiting(session.id);
    const notes = [
      ...(dropped
        ? [
            factoryMessage(
              `${dropped} earlier Factory message${dropped === 1 ? ' was' : 's were'} dropped before this session read ${dropped === 1 ? 'it' : 'them'}. Check the card and its sources for anything you missed.`,
              'factory',
            ),
          ]
        : []),
      ...waiting.map(message => factoryMessage(message.text, message.source, message.attributes)),
    ];
    const extra = (input as ClaudeTurnInput).context ?? [];
    const turn: ClaudeTurnInput = { ...input, context: [...notes, ...told.map(contextNotice), ...extra] };
    // Set before Claude Code reads the turn: `send` queues it and returns without yielding to it.
    const { runId } = await session.send(turn);
    this.#runContexts.set(runId, context);
    this.#started.add(`${session.id} ${runId}`);
    // Bounded: a re-claim that needs an entry comes within a lease or two of the run starting.
    for (const oldest of this.#started) {
      if (this.#started.size <= MAX_STARTED_RUNS) break;
      this.#started.delete(oldest);
    }
    const known = this.#told.get(session.id) ?? new Map<string, ClaudeAgentContextBlock>();
    for (const block of told) known.set(block.id, block);
    this.#told.set(session.id, known);
    return runId;
  }

  async #observe(result: ClaudeAgentToolResult): Promise<void> {
    try {
      await this.#deps.onToolResult?.(result);
    } catch (error) {
      console.warn(`[factory] Claude Agent session ${result.sessionId}: observing ${result.toolName} failed`, error);
    }
  }

  /** Follow Claude Code's own shell commands from its event stream, and report each one that finished. */
  #shellWatcher(sessionId: string, workspace: { requestContext?: (hostContext: unknown) => RequestContext }) {
    const report = this.#deps.onShellResult;
    const contextFor = workspace.requestContext;
    if (!report || !contextFor) return () => {};
    const calls = new Map<string, { command?: string; runId?: string; stdout: string }>();
    return (event: FactoryEvent) => {
      if (event.type === 'tool.started') {
        if (event.category !== 'shell' || event.executor !== 'runtime') return;
        calls.set(event.callId, {
          command: commandOf(event.input),
          ...(event.runId ? { runId: event.runId } : {}),
          stdout: '',
        });
        return;
      }
      const call = calls.get((event as { callId?: string }).callId ?? '');
      if (!call) return;
      if (event.type === 'tool.input') call.command = commandOf(event.input) ?? call.command;
      else if (event.type === 'tool.output' && event.stream === 'stdout') call.stdout += event.chunk;
      else if (event.type === 'tool.ended') {
        calls.delete(event.callId);
        if (!call.command) return;
        const hostContext = call.runId ? this.#runContexts.get(call.runId) : undefined;
        const output = call.stdout || (typeof event.result === 'string' ? event.result : '');
        void report({
          sessionId,
          callId: event.callId,
          command: call.command,
          output,
          ...(event.error ? { error: event.error } : {}),
          requestContext: contextFor(hostContext),
        }).catch(error =>
          console.warn(`[factory] Claude Agent session ${sessionId}: observing a command failed`, error),
        );
      }
    };
  }

  /**
   * Tell whoever waits on a run how it ended, with its usage. A run parked on a person has not ended:
   * they are told so, with how it ends once the person answers (`resumed`).
   */
  #settleRun(runId: string, end: RuntimeRunEnd): void {
    const waiting = this.#runEnds.get(runId);
    this.#runEnds.delete(runId);
    if (!waiting) return;
    if (end.reason === 'awaiting_interaction') {
      waiting({ ...end, resumed: new Promise<RuntimeRunEnd>(resolve => this.#runEnds.set(runId, resolve)) });
      return;
    }
    const usage = this.#runUsage.get(runId);
    waiting({ ...end, ...(usage?.length ? { usage } : {}) });
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
  /**
   * The session's checkout posture: untrusted once it was ever untrusted (this process remembers it,
   * and so does the session's record), or when it can't be read.
   */
  async #posture(sessionId: string): Promise<CheckoutPosture> {
    if (this.#sticky.has(sessionId)) return 'untrusted';
    let record: AgentSessionRecord | undefined;
    let posture: CheckoutPosture;
    try {
      record = await this.#deps.sessions.get(sessionId);
      posture =
        (record?.runtimeState as { untrustedCheckout?: unknown } | undefined)?.untrustedCheckout === true
          ? 'untrusted'
          : this.#deps.checkout
            ? await this.#deps.checkout(sessionId)
            : 'trusted';
    } catch {
      posture = 'untrusted';
    }
    if (posture === 'untrusted') {
      this.#sticky.add(sessionId);
      if ((record?.runtimeState as { untrustedCheckout?: unknown } | undefined)?.untrustedCheckout !== true) {
        // Merged into the state as it is when the write lands, not as `record` had it: Claude may have
        // started a new conversation since, and putting back the older resume id would lose it. Not
        // awaited: this process enforces the mark from memory, and the write queues behind any other.
        void this.#saveState(
          sessionId,
          async () => ({
            ...((await this.#deps.sessions.get(sessionId).catch(() => record))?.runtimeState as object | undefined),
            ...this.#resume.get(sessionId),
            ...this.#opened.get(sessionId)?.session.runtimeState(),
            untrustedCheckout: true,
          }),
          'recording its untrusted checkout',
        );
      }
    }
    return posture;
  }

  /**
   * Write the session record's state. Writes land in the order they were asked for, each computed when
   * its turn comes, so a slower writer never puts back state a later one replaced. Failures are logged.
   */
  #saveState(sessionId: string, state: () => Promise<Record<string, unknown>>, what: string): Promise<void> {
    const write = (this.#stateWrites.get(sessionId) ?? Promise.resolve())
      .then(async () => this.#deps.sessions.setRuntimeState(sessionId, await state()))
      .catch(error => console.warn(`[factory] Claude Agent session ${sessionId}: ${what} failed`, error));
    this.#stateWrites.set(sessionId, write);
    void write.then(() => {
      if (this.#stateWrites.get(sessionId) === write) this.#stateWrites.delete(sessionId);
    });
    return write;
  }

  /** What the session's record keeps: Claude's resume state, and the sticky untrusted mark. */
  #stateOf(sessionId: string, session: ClaudeAgentSession): Record<string, unknown> {
    return { ...session.runtimeState(), ...(this.#sticky.has(sessionId) ? { untrustedCheckout: true } : {}) };
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

  /**
   * The Factory messages that waited for this turn, which it now carries. One that can't be read
   * keeps waiting for a later turn rather than holding this one up.
   */
  async #waiting(sessionId: string): ReturnType<AgentMessageStore['take']> {
    try {
      return await this.#messages.take(sessionId);
    } catch (error) {
      console.warn(`[factory] Claude Agent session ${sessionId}: reading its waiting messages failed`, error);
      return { messages: [], dropped: 0 };
    }
  }

  /** A Factory message to the session, as it is kept. */
  #message(sessionId: string, message: Parameters<FactoryRuntimeSessions['message']>[1]): AgentMessage {
    const { delivery } = message;
    this.#lastMessageAt = Math.max(Date.now(), this.#lastMessageAt + 1);
    return {
      id: delivery?.id ?? randomUUID(),
      sessionId,
      source: message.source,
      text: message.text,
      // A notification Claude can answer carries its id, as Mastra Code's do.
      ...(message.attributes || delivery
        ? { attributes: { ...message.attributes, ...(delivery ? { id: delivery.id } : {}) } }
        : {}),
      ...(delivery
        ? {
            delivery: {
              threadId: delivery.threadId,
              kind: delivery.kind,
              priority: delivery.priority,
              ...(delivery.sourceId ? { sourceId: delivery.sourceId } : {}),
            },
          }
        : {}),
      createdAt: new Date(this.#lastMessageAt),
    };
  }

  /** fork(claude-agent): keep the text of the latest turn's last assistant message, for `askedPerson`. */
  #followReply(sessionId: string, event: FactoryEvent): void {
    if (event.type === 'run.started') this.#lastReply.delete(sessionId);
    else if (event.type === 'message.started' && event.role === 'assistant') {
      this.#lastReply.set(sessionId, { messageId: event.messageId, text: '' });
    } else if (event.type === 'message.delta' && event.part === 'text') {
      const reply = this.#lastReply.get(sessionId);
      if (reply?.messageId === event.messageId) reply.text += event.delta;
    }
  }

  /**
   * fork(claude-agent): the question the session's last turn ended on, asked in plain text, when the
   * run's goal needs a person's answer to it: the cheap check first, the judge only when it can't tell.
   */
  async #askedPerson(sessionId: string, goal: { objective: string }): Promise<string | undefined> {
    const text = this.#lastReply.get(sessionId)?.text.trim();
    if (!text || !this.#deps.waitingJudge || plainTextQuestion(text) === 'none') return undefined;
    let verdict: WaitingVerdict | undefined;
    try {
      verdict = await this.#deps.waitingJudge({ objective: goal.objective, text });
    } catch (error) {
      console.warn(
        `[factory] Claude Agent session ${sessionId}: judging whether its turn waits on a person failed`,
        error,
      );
      return undefined;
    }
    if (!verdict?.waiting) return undefined;
    return verdict.question || lastParagraph(text);
  }

  /**
   * fork(claude-agent): park a board run on a question its turn asked in plain text. It is asked
   * through the broker, so it waits in the inbox and attention lists as `ask_user` does; an answer
   * there becomes the person's reply in the session, and so does a message they type in it. Either
   * reply's turn is what `resumed` ends with.
   */
  async #awaitReply(
    sessionId: string,
    question: string,
    requestContext: RequestContext,
  ): Promise<{ resumed: Promise<RuntimeRunEnd> } | undefined> {
    const broker = this.#deps.interactions;
    if (!broker || !this.#opened.has(sessionId)) return undefined;
    this.#awaitingReply.get(sessionId)?.drop();
    const signal = new AbortController();
    let settle!: (end: RuntimeRunEnd) => void;
    const resumed = new Promise<RuntimeRunEnd>(resolve => (settle = resolve));
    const entry: AwaitingReply = {
      replied: runId => {
        this.#awaitingReply.delete(sessionId);
        this.#runEnds.set(runId, settle);
        signal.abort();
        return error => {
          this.#runEnds.delete(runId);
          settle({ reason: 'error', error: error instanceof Error ? error.message : String(error) });
        };
      },
      drop: () => {
        this.#awaitingReply.delete(sessionId);
        signal.abort();
        settle({ reason: 'aborted' });
      },
    };
    this.#awaitingReply.set(sessionId, entry);
    void broker
      .request(sessionId, { kind: 'question', question }, { signal: signal.signal })
      .then(async response => {
        if (this.#awaitingReply.get(sessionId) !== entry) return;
        this.#awaitingReply.delete(sessionId);
        const answer = Array.isArray(response.answer) ? response.answer.join(', ') : response.answer;
        const runId = randomUUID();
        this.#runEnds.set(runId, settle);
        try {
          const session = await this.#ready(sessionId, requestContext);
          if (!session) throw new Error(`Session ${sessionId} no longer runs on Claude Agent.`);
          await this.#send(session, { text: answer, runId }, requestContext);
        } catch (error) {
          this.#runEnds.delete(runId);
          console.warn(`[factory] Claude Agent session ${sessionId}: sending the person's answer failed`, error);
          settle({ reason: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      })
      .catch(() => {
        // Cancelled: by the person's own reply in the session (handled there), or with the run.
        if (this.#awaitingReply.get(sessionId) !== entry) return;
        this.#awaitingReply.delete(sessionId);
        settle({ reason: 'aborted' });
      });
    return { resumed };
  }

  /** Board runs on Claude Agent sessions, for the dispatcher. */
  runtimeSessions(): FactoryRuntimeSessions {
    return {
      // A failed lookup throws: the caller must not guess a runtime.
      runs: async sessionId => (await this.#deps.sessions.get(sessionId))?.runtimeId === CLAUDE_AGENT_RUNTIME_ID,
      hasRun: async (sessionId, runId) => this.#started.has(`${sessionId} ${runId}`),
      isRunning: sessionId => this.#opened.get(sessionId)?.session.status() === 'running',
      parkedBoardRun: async sessionId => {
        const parked = this.#parked.get(sessionId);
        const session = this.#opened.get(sessionId)?.session;
        if (!parked || !session || session.currentRunId() !== parked.runId || !this.#boardRuns.has(parked.runId))
          return false;
        const pending = (await this.#deps.interactions?.listPending({ sessionId })) ?? [];
        return pending.some(record => record.callId === parked.callId);
      },
      awaitsPerson: async sessionId => ((await this.#deps.interactions?.listPending({ sessionId })) ?? []).length > 0,
      askedPerson: (sessionId, goal) => this.#askedPerson(sessionId, goal),
      awaitReply: (sessionId, { question }, requestContext) => this.#awaitReply(sessionId, question, requestContext),
      idle: sessionId => {
        if (this.#opened.get(sessionId)?.session.status() !== 'running') return Promise.resolve();
        return new Promise<void>(resolve => {
          const waiting = this.#idle.get(sessionId) ?? [];
          waiting.push(resolve);
          this.#idle.set(sessionId, waiting);
        });
      },
      kickoff: async (sessionId, kickoff, requestContext) => {
        // fork(claude-agent): a new phase's kickoff drops a question the last run waits on.
        this.#awaitingReply.get(sessionId)?.drop();
        // A goal's re-kick goes on in the same phase, so the Claude Code it has applies as it is.
        const session = await this.#ready(sessionId, requestContext, {
          restartIdle: kickoff.continuation === undefined,
        });
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
        const text =
          kickoff.continuation ??
          withWorkItemDescription(
            skill ? skillKickoffText(skill.name, skill) : (kickoff.prompt ?? ''),
            kickoff.description,
          );
        const context = [
          ...(kickoff.preface ? [factoryMessage(kickoff.preface, 'stage-transition')] : []),
          ...(kickoff.goal ? [goalNotice(kickoff.goal)] : []),
        ];
        const ended = new Promise<RuntimeRunEnd>(resolve => this.#runEnds.set(kickoff.runId, resolve));
        // Only this run's plans: a person's own submit_plan in another turn always waits for them.
        if (kickoff.autoApprovePlan) this.#autoApprove.set(kickoff.runId, kickoff.autoApprovePlan);
        this.#boardRuns.add(kickoff.runId);
        void ended.then(() => this.#autoApprove.delete(kickoff.runId));
        try {
          await this.#send(
            session,
            {
              runId: kickoff.runId,
              text,
              ...(context.length ? { context } : {}),
              ...(kickoff.continuation !== undefined
                ? { notice: { kind: 'system-reminder', tag: 'goal-judge', attributes: { type: 'goal-judge' } } }
                : skill
                  ? { notice: { kind: 'reactive', tag: 'skill', attributes: { name: skill.name } } }
                  : {}),
            },
            requestContext,
          );
        } catch (error) {
          this.#runEnds.delete(kickoff.runId);
          this.#autoApprove.delete(kickoff.runId);
          this.#boardRuns.delete(kickoff.runId);
          throw error;
        }
        return { ended };
      },
      message: async (sessionId, message, requestContext) => {
        const kept = this.#message(sessionId, message);
        if (!message.wake) {
          // Kept for the session's next turn, dropping the oldest past the cap; a restart keeps it too.
          await this.#messages.hold(kept, MAX_WAITING_MESSAGES);
          return {};
        }
        const session = await this.#ready(sessionId, requestContext);
        if (!session) {
          throw new FactoryDispatchError('session_unavailable', `Session ${sessionId} does not run on Claude Agent.`);
        }
        const { text, ...shown } = factoryMessage(kept.text, kept.source, kept.attributes);
        // Kept before Claude reads it, so the session can answer it and the sender's limit counts it;
        // a message that can't be kept isn't sent, and one whose turn never started is forgotten.
        await this.#messages.told(kept);
        try {
          return { runId: await this.#send(session, { text, notice: shown }, requestContext) };
        } catch (error) {
          await this.#messages
            .forget(sessionId, kept.id)
            .catch(forgetting =>
              console.warn(
                `[factory] Claude Agent session ${sessionId}: forgetting an unsent message failed`,
                forgetting,
              ),
            );
          throw error;
        }
      },
      deliveries: {
        durable: this.#messages.durable,
        get: (sessionId, id) => this.#messages.get(sessionId, id),
        recentOnThread: (threadId, limit) => this.#messages.recentOnThread(threadId, limit),
        claimReply: (sessionId, id, leaseUntil) => this.#messages.claimReply(sessionId, id, leaseUntil),
        extendReply: (sessionId, id, leaseUntil) => this.#messages.extendReply(sessionId, id, leaseUntil),
        confirmReply: (sessionId, id) => this.#messages.confirmReply(sessionId, id),
        releaseReply: (sessionId, id) => this.#messages.releaseReply(sessionId, id),
      },
      abort: async (sessionId, requestContext) => {
        await this.commands().abort(sessionId, { context: requestContext });
      },
      approvals: {
        waiting: async sessionId =>
          (await this.#decisions(sessionId)).map(record => ({
            toolCallId: record.callId!,
            toolName: interactionToolName(record.request),
          })),
        answer: async (sessionId, toolCallId, { decision, reason, answeredBy }, requestContext) => {
          // Looked up first: a stale button never starts Claude Code or its workspace.
          const pending = (await this.#decisions(sessionId)).find(record => record.callId === toolCallId);
          if (!pending) return 'not_pending';
          const session = await this.open(sessionId, requestContext);
          if (!session) return 'not_pending';
          const approved = decision === 'approve';
          const response: InteractionResponse =
            pending.request.kind === 'plan_approval'
              ? approved
                ? { kind: 'plan_approval', action: 'approved' }
                : { kind: 'plan_approval', action: 'rejected', ...(reason ? { feedback: reason } : {}) }
              : { kind: 'tool_approval', approved, ...(!approved && reason ? { reason } : {}) };
          const result = await this.#resolve(session, pending, response, requestContext, answeredBy);
          return result.ok ? 'answered' : 'not_pending';
        },
      },
    };
  }

  /** The calls a session waits on that a yes or no answers (a plan, a gated tool), oldest first. */
  async #decisions(sessionId: string): Promise<InteractionRecord[]> {
    const pending = (await this.#deps.interactions?.listPending({ sessionId })) ?? [];
    return pending.filter(record => record.callId !== undefined && answersWithDecision(record.request));
  }

  /**
   * Answer what the session waits on. When nobody waits any more (the server restarted while the
   * human decided), Claude Code's call is gone, so the answer reaches the conversation as a message.
   */
  async #resolve(
    session: ClaudeAgentSession,
    pending: InteractionRecord,
    response: InteractionResponse,
    context: unknown,
    resolvedBy: string | undefined,
  ): Promise<CommandResult> {
    const broker = this.#deps.interactions;
    if (!broker) return { ok: false, reason: 'not_pending', message: 'no_pending_interaction' };
    const outcome = await broker.resolve(pending.id, response, resolvedBy ? { resolvedBy } : {});
    if (outcome.status === 'not_pending')
      return { ok: false, reason: 'not_pending', message: 'no_pending_interaction' };
    if (outcome.status === 'queued') await this.#send(session, { text: lateAnswer(pending, response) }, context);
    return { ok: true };
  }

  commands(): SessionCommands {
    const notFound: CommandResult = { ok: false, reason: 'session_not_found' };
    const notPending: CommandResult = { ok: false, reason: 'not_pending', message: 'no_pending_interaction' };
    return {
      send: async (sessionId, input, request) => {
        const session = await this.#ready(sessionId, request.context);
        if (!session) return notFound;
        // fork(claude-agent): a board run parked on its plain-text question takes this as the reply.
        const runId = randomUUID();
        const failed = this.#awaitingReply.get(sessionId)?.replied(runId);
        try {
          await this.#send(session, { ...input, runId }, request.context);
        } catch (error) {
          failed?.(error);
          throw error;
        }
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
        return this.#resolve(
          session,
          pending,
          response,
          request.context,
          toolIdentity(contextOf(request.context)).userId,
        );
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

  /**
   * Stop every Claude Code this process runs. A run in flight ends as stopped and says the server shut
   * down; a Claude Code the shutdown's signal reached first ends the same way (see `signalGraceMs`).
   */
  async shutdown(): Promise<void> {
    await this.#stopAll(SHUTDOWN_NOTICE);
  }

  /** Close every Claude Code this process runs; a run in flight ends as stopped, saying `notice`. */
  async #stopAll(notice: string): Promise<void> {
    const sessions = await Promise.allSettled(this.#live.values());
    this.#live.clear();
    this.#opened.clear();
    await Promise.allSettled(
      sessions.flatMap(result => (result.status === 'fulfilled' && result.value ? [result.value.close(notice)] : [])),
    );
  }
}

/** Why a run in flight stopped when the server shut down. */
const SHUTDOWN_NOTICE = 'This run was stopped because the Factory server shut down or restarted.';

/** Why a run in flight stopped when this process lost the right to run Claude Agent sessions. */
const HOST_LOST_NOTICE =
  'This run was stopped because another Factory process sharing this database now runs Claude Agent sessions.';

/** How many started runs this process remembers for the replay guard. */
const MAX_STARTED_RUNS = 1000;

/** Factory messages a session holds for its next turn; past this the oldest are dropped. */
const MAX_WAITING_MESSAGES = 20;

/** A Factory tool call that finished in a Claude Agent session. */
export interface ClaudeAgentToolResult {
  sessionId: string;
  /** Claude's `tool_use` id. */
  callId: string;
  toolName: string;
  input: unknown;
  status: 'success' | 'error';
  value?: unknown;
  error?: unknown;
  /** The request context the call ran with (the turn's caller, the session's controller context). */
  requestContext: RequestContext;
}

/** One of Claude Code's own shell commands, finished. */
export interface ClaudeAgentShellResult {
  sessionId: string;
  callId: string;
  command: string;
  /** What the command printed on stdout. */
  output: string;
  error?: string;
  requestContext: RequestContext;
}

function commandOf(input: unknown): string | undefined {
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' ? command : undefined;
}

/** fork(claude-agent): a board run waiting on the reply to a question its turn asked in plain text. */
interface AwaitingReply {
  /** The person replied in the session, in the turn `runId`: the run follows that turn. Call the result if it failed to start. */
  replied(runId: string): (error: unknown) => void;
  /** Stop waiting (another kickoff): the run ends as aborted. */
  drop(): void;
}

/** The last paragraph of a message, as the question it ends on when the judge named none. */
function lastParagraph(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  return (paragraphs.at(-1) ?? text).slice(-1_000);
}

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

/** The goal a board run pursues, as Mastra Code's goal reminder shows it. */
function goalNotice(goal: { objective: string; maxRuns: number }): ClaudeTurnNotice {
  return {
    kind: 'system-reminder',
    tag: 'goal',
    text: goal.objective,
    attributes: { type: 'goal', maxRuns: goal.maxRuns },
  };
}

/** Something Factory tells the session, shown as Factory's in the transcript. */
function factoryMessage(
  text: string,
  source: string,
  attributes?: Record<string, string | number | boolean>,
): ClaudeTurnNotice {
  return { kind: 'reactive', tag: 'factory-message', text, attributes: { ...attributes, source } };
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
  // A session with no record runs on the fallback; one whose record can't be read runs nowhere yet:
  // guessing would send a Claude Agent session's turn to Mastra Code.
  const target = async (sessionId: string): Promise<SessionCommands | CommandResult> => {
    try {
      const record = await options.sessions.get(sessionId);
      return (record && options.runtimes[record.runtimeId]) || options.fallback;
    } catch (error) {
      console.warn(`[factory] Session ${sessionId}: reading its runtime failed`, error);
      return { ok: false, reason: 'unavailable', message: "The session's runtime could not be read; try again." };
    }
  };
  const isCommands = (value: SessionCommands | CommandResult): value is SessionCommands => 'send' in value;
  return {
    send: async (sessionId, input, request) => {
      const to = await target(sessionId);
      return isCommands(to) ? to.send(sessionId, input, request) : to;
    },
    abort: async (sessionId, request) => {
      const to = await target(sessionId);
      return isCommands(to) ? to.abort(sessionId, request) : to;
    },
    answer: async (sessionId, at, response, request) => {
      const to = await target(sessionId);
      return isCommands(to) ? to.answer(sessionId, at, response, request) : to;
    },
    setModel: async (sessionId, model, request) => {
      const to = await target(sessionId);
      return isCommands(to) ? to.setModel(sessionId, model, request) : to;
    },
  };
}
