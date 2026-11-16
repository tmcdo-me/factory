import { randomUUID } from 'node:crypto';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FactoryEvent, RunEndReason, SendInput } from '@factory/agent-runtime';

import { CLAUDE_AGENT_BUILTIN_TOOLS, CLAUDE_AGENT_DISALLOWED_TOOLS, SKILL_TOOL } from './builtin-tools';
import { ClaudeAgentEventMapper } from './event-mapper';
import { FACTORY_TOOLS_INSTRUCTIONS, createFactoryMcpServer } from './factory-tools';
import type { ClaudeAgentFactoryTools } from './factory-tools';
import type { ClaudeAgentSkills } from './skills';
import { FACTORY_MCP_SERVER } from './tool-classification';

/**
 * Instruction files Claude Code would pick up from the folders above the session's checkout. It
 * reads CLAUDE.md (and .claude/) from every parent of its working directory, so a checkout under
 * the operator's home would load their personal `~/.claude/CLAUDE.md`. Only the repository's own
 * instructions should apply.
 */
export function instructionFilesAbove(cwd: string): string[] {
  const patterns: string[] = [];
  let dir = cwd.replace(/\/+$/, '');
  while (dir.includes('/') && dir !== '') {
    dir = dir.slice(0, dir.lastIndexOf('/'));
    const base = dir === '' ? '' : dir;
    patterns.push(`${base}/CLAUDE.md`, `${base}/CLAUDE.local.md`, `${base}/AGENTS.md`, `${base}/.claude/**`);
  }
  return patterns;
}

/** Claude Code settings that keep a Factory session apart from the operator's own Claude setup. */
export const CLAUDE_AGENT_ISOLATION = {
  disableClaudeAiConnectors: true,
  disableBundledSkills: true,
  autoMemoryEnabled: false,
} as const;

/** Appended to the system prompt when the session has Factory's skills. */
export const SKILLS_INSTRUCTIONS =
  "Factory's skills are the `factory:*` skills (`factory-plan` is `factory:factory-plan`). When a skill says to read one of its files with `skill_read`, read that file from the skill's folder with Read.";

/** How long a stopped Claude Code may take to exit before a new one starts anyway. */
const STOP_EXIT_TIMEOUT_MS = 10_000;

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeAgentSessionOptions {
  sessionId: string;
  /**
   * How long a Claude Code that was told to stop (SIGTERM, SIGINT, SIGHUP) waits for the host to close
   * the session before its run counts as failed. The host's own shutdown signals Claude Code with it,
   * often before it gets to close the session. Default 2 seconds.
   */
  signalGraceMs?: number;
  /** The session's working directory (its checkout). */
  cwd: string;
  emit(event: FactoryEvent): void;
  model?: string;
  /** Factory's instructions, appended to Claude Code's own system prompt. */
  instructions?: string;
  /** Factory's tools, served to Claude as the in-process MCP server `factory`. */
  factoryTools?: ClaudeAgentFactoryTools;
  /** Factory's skills for this session (see `writeSkillsPlugin`); no others are enabled. */
  skills?: ClaudeAgentSkills;
  /** Claude Code session id to resume (from `runtimeState()`). */
  resume?: string;
  /**
   * The checkout holds content nobody vetted (a pull request under review): its CLAUDE.md and
   * `.claude/` settings, hooks included, could be anyone's, so none of them load.
   */
  untrustedCheckout?: boolean;
  /**
   * Subprocess environment; build it with `claudeProcessEnv`. A function is asked again each time
   * Claude Code starts (after an idle close or a recycle), so credentials refreshed since (a
   * re-minted `GH_TOKEN`) reach the new process.
   */
  env: Record<string, string> | (() => Promise<Record<string, string>>);
  /**
   * Stop Claude Code after this long with no run open; the next turn starts it again, resuming
   * the conversation from its transcript. Frees the process (and a sandbox it keeps awake).
   */
  idleCloseMs?: number;
  /**
   * Stop Claude Code when a run ends and it has run this long, so the next turn starts it with a
   * fresh environment (short-lived credentials such as a GitHub installation token).
   */
  recycleAfterMs?: number;
  /** Launch Claude Code somewhere other than this host (e.g. inside a Sprite). */
  spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess'];
  /** An installed `claude` instead of the SDK's bundled one. */
  pathToClaudeCodeExecutable?: string;
  /** Injected for tests; defaults to the SDK's `query`. */
  query?: QueryFn;
  newId?: () => string;
}

export interface ClaudeAgentRuntimeState {
  claudeSessionId?: string;
}

/** Context Factory hands Claude with a turn; the transcript shows it as a notice, not as the user's words. */
export interface ClaudeTurnNotice {
  /** The notice's kind, as Mastra Code names its signals (`state`, `reactive`, `system-reminder`). */
  kind: string;
  /** The element Claude reads it in, e.g. `factory-phase`. */
  tag: string;
  text: string;
  attributes?: Record<string, string | number | boolean>;
}

/** One turn: the user's message, or a turn Factory starts (a board kickoff, a notification). */
export interface ClaudeTurnInput extends SendInput {
  /** The run's id, for a caller that must recognise the run later (a kickoff's delivery id). */
  runId?: string;
  /** Read by Claude ahead of `text`, each shown in the transcript as its own notice. */
  context?: readonly ClaudeTurnNotice[];
  /** Show `text` itself as a notice (a skill kickoff) rather than a message the user typed. */
  notice?: Omit<ClaudeTurnNotice, 'text'>;
}

/** A simple async queue feeding the SDK's streaming input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(item: SDKUserMessage): void {
    this.#items.push(item);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const item = this.#items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>(resolve => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

/**
 * One Factory session on Claude Agent: a long-lived `query()` in streaming-input mode, running the
 * unmodified Claude Code binary in the session's working directory. Each `send` is a run; the SDK
 * answers turns in order, and each turn's `result` closes the oldest open run.
 */
export class ClaudeAgentSession {
  readonly id: string;
  readonly #options: ClaudeAgentSessionOptions;
  readonly #mapper = new ClaudeAgentEventMapper();
  readonly #newId: () => string;
  #input: InputQueue | undefined;
  #query: Query | undefined;
  #pump: Promise<void> | undefined;
  /** Open runs, oldest first. */
  readonly #runs: string[] = [];
  #aborting = false;
  #closed = false;
  #claudeSessionId: string | undefined;
  /** When the running Claude Code started. */
  #startedAt = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** A start waiting on the environment (`env` as a function), or on the previous process's exit. */
  #starting: Promise<void> | undefined;
  /** A Claude Code stopped on purpose that is still exiting: a new one waits for it. */
  #stopping: Promise<void> | undefined;
  /**
   * Background work Claude Code reports running (shells, subagents, monitors), from its
   * `background_tasks_changed` level signal; the process is not stopped while there is any.
   */
  #background = new Set<string>();

  constructor(options: ClaudeAgentSessionOptions) {
    this.id = options.sessionId;
    this.#options = options;
    this.#newId = options.newId ?? randomUUID;
    this.#claudeSessionId = options.resume;
  }

  status(): 'idle' | 'running' | 'closed' {
    if (this.#closed) return 'closed';
    return this.#runs.length ? 'running' : 'idle';
  }

  /** The run Claude Code is answering now (the oldest open one), if any. */
  currentRunId(): string | undefined {
    return this.#runs[0];
  }

  runtimeState(): ClaudeAgentRuntimeState {
    return this.#claudeSessionId ? { claudeSessionId: this.#claudeSessionId } : {};
  }

  /** Start a turn. Turns sent while one runs queue behind it, as in Claude Code. */
  async send(input: ClaudeTurnInput): Promise<{ runId: string }> {
    if (this.#closed) throw new Error(`Session ${this.id} is closed`);
    const runId = input.runId ?? this.#newId();
    this.#runs.push(runId);
    this.#options.emit({ type: 'run.started', runId });
    for (const notice of [...(input.context ?? []), ...(input.notice ? [{ ...input.notice, text: input.text }] : [])]) {
      this.#options.emit({
        type: 'notice',
        noticeId: this.#newId(),
        kind: notice.kind,
        tag: notice.tag,
        text: notice.text,
        ...(notice.attributes ? { attributes: notice.attributes } : {}),
        runId,
      });
    }
    if (!input.notice) {
      const messageId = this.#newId();
      this.#options.emit({ type: 'message.started', messageId, role: 'user', runId });
      this.#options.emit({ type: 'message.delta', messageId, part: 'text', delta: input.text });
      this.#options.emit({ type: 'message.ended', messageId });
    }
    this.#clearIdle();
    const env = this.#options.env;
    if (!this.#query && !this.#stopping && typeof env !== 'function') this.#start(env);
    else if (!this.#query || this.#starting) {
      // Turns sent while the environment is fetched queue behind the first, in order.
      try {
        await this.#ensureStarted();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#runs.splice(this.#runs.indexOf(runId), 1);
        this.#options.emit({ type: 'error', message, retryable: true, runId });
        this.#options.emit({ type: 'run.ended', runId, reason: 'error', error: message });
        throw error;
      }
    }
    this.#input!.push({
      type: 'user',
      message: { role: 'user', content: userContent({ ...input, text: turnText(input) }) },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    return { runId };
  }

  async abort(): Promise<void> {
    if (!this.#query || !this.#runs.length) return;
    this.#aborting = true;
    await this.#query.interrupt();
  }

  async setModel(modelId: string): Promise<void> {
    if (this.#query) await this.#query.setModel(modelId);
    this.#options.model = modelId;
  }

  /**
   * Stop Claude Code; its open runs end as aborted. `notice`, when given, says why in the transcript
   * (the host shutting down), on the run in flight.
   */
  async close(notice?: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeNotice = notice;
    this.#onClose?.();
    this.#clearIdle();
    this.#input?.close();
    this.#query?.close();
    await this.#pump?.catch(() => undefined);
    this.#noticeClose();
    this.#endOpenRuns('aborted', 'Session closed');
  }

  /** Start Claude Code if it isn't running, asking `env` for the environment when it is a function. */
  async #ensureStarted(): Promise<void> {
    const env = this.#options.env;
    if (this.#query && !this.#starting) return;
    // Never two Claude Codes on one transcript: a stopped one finishes exiting first.
    this.#starting ??= Promise.all([this.#stopping, typeof env === 'function' ? env() : env])
      .then(([, resolved]) => {
        if (this.#closed) throw new Error(`Session ${this.id} is closed`);
        this.#start(resolved);
      })
      .finally(() => {
        this.#starting = undefined;
      });
    return this.#starting;
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  /**
   * After the last open run ended (or the last background task did): recycle Claude Code now, or
   * stop it once it stayed idle. Never while it reports background work running: stopping it would
   * kill that work; the stop is armed again when the work ends.
   */
  #whenIdle(): void {
    this.#clearIdle();
    if (this.#closed || this.#runs.length || !this.#query || this.#background.size) return;
    const { recycleAfterMs, idleCloseMs } = this.#options;
    if (recycleAfterMs !== undefined && Date.now() - this.#startedAt >= recycleAfterMs) {
      this.#stopProcess();
      return;
    }
    if (idleCloseMs === undefined || idleCloseMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (!this.#runs.length && !this.#background.size) this.#stopProcess();
    }, idleCloseMs);
    this.#idleTimer.unref?.();
  }

  /**
   * Stop the running Claude Code without closing the session: the next turn starts a new one,
   * resuming the conversation. Forgotten at once, so a turn sent meanwhile never lands in it.
   */
  #stopProcess(): void {
    const query = this.#query;
    const input = this.#input;
    const pump = this.#pump;
    if (!query) return;
    this.#query = undefined;
    this.#input = undefined;
    input?.close();
    query.close();
    // Its messages end once the process exited; bounded, so a wedged exit can't hold the session.
    const exited = Promise.race([
      pump?.catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, STOP_EXIT_TIMEOUT_MS).unref?.()),
    ]).then(() => {
      if (this.#stopping === exited) this.#stopping = undefined;
    });
    this.#stopping = exited;
  }

  #start(env: Record<string, string>): void {
    if (this.#query) return;
    const input = new InputQueue();
    this.#input = input;
    const options = this.#options;
    const factoryTools = options.factoryTools?.defs.length ? options.factoryTools : undefined;
    const skills = options.skills?.names.length ? options.skills : undefined;
    const instructions = [
      options.instructions,
      factoryTools ? FACTORY_TOOLS_INSTRUCTIONS : undefined,
      skills ? SKILLS_INSTRUCTIONS : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
    const query = (options.query ?? (sdkQuery as QueryFn))({
      prompt: input,
      options: {
        cwd: options.cwd,
        env,
        ...(options.model ? { model: options.model } : {}),
        ...(this.#claudeSessionId ? { resume: this.#claudeSessionId } : {}),
        includePartialMessages: true,
        // Claude works inside the session's own checkout, with the same trust as Mastra Code's
        // sandbox tools. Factory's own tools keep their approval rules on Factory's side.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // The repository's CLAUDE.md and .claude/ apply; the operator's personal ~/.claude does not.
        // An untrusted checkout's own settings don't apply either.
        settingSources: options.untrustedCheckout ? [] : ['project'],
        // Isolation: nothing of the operator's Claude account or install reaches the session beyond
        // the model. No claude.ai connectors (mail, calendars, homelab), no MCP servers but Factory's,
        // no skills but Factory's (bundled and repository skills stay off), no auto-memory.
        settings: { ...CLAUDE_AGENT_ISOLATION, claudeMdExcludes: instructionFilesAbove(options.cwd) },
        strictMcpConfig: true,
        ...(factoryTools
          ? {
              mcpServers: {
                [FACTORY_MCP_SERVER]: createFactoryMcpServer(factoryTools, {
                  currentRunId: () => this.#runs[0],
                  newId: this.#newId,
                }),
              },
            }
          : {}),
        // Factory's skills come as one local plugin; `skills` enables exactly those.
        ...(skills ? { plugins: [skills.plugin] } : {}),
        skills: skills ? skills.names : [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(instructions ? { append: instructions } : {}),
        },
        // An allow-list of built-in tools (see builtin-tools.ts); the Skill tool only with skills.
        tools: [...CLAUDE_AGENT_BUILTIN_TOOLS, ...(skills ? [SKILL_TOOL] : [])],
        disallowedTools: [...CLAUDE_AGENT_DISALLOWED_TOOLS, ...(skills ? [] : [SKILL_TOOL])],
        ...(options.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: options.spawnClaudeCodeProcess } : {}),
        ...(options.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
          : {}),
      },
    });
    this.#query = query;
    this.#startedAt = Date.now();
    // The background-task level is per process: a new one starts with none.
    this.#background.clear();
    this.#pump = this.#drain(query);
  }

  async #drain(query: Query): Promise<void> {
    // A Claude Code stopped on purpose (idle, recycled) is no longer `#query`: its end is no news.
    const current = () => this.#query === query || this.#closed;
    try {
      for await (const message of query) this.#handle(message);
      if (current()) this.#endOpenRuns('error', 'Claude Code exited');
    } catch (error) {
      if (!current()) return;
      const text = error instanceof Error ? error.message : String(error);
      // Told to stop: by the host's own shutdown (which signals Claude Code with it, often before it
      // closes the session), or by something else (an out-of-memory killer, an evicted container). Only
      // the host closing the session soon after makes it a stop; anything else is a failure.
      if (!this.#closed && stoppedBySignal(text)) await this.#closedWithin(this.#options.signalGraceMs ?? 2_000);
      const runId = this.#runs[0];
      if (this.#closed) {
        this.#noticeClose();
        this.#endOpenRuns('aborted', text);
        return;
      }
      this.#options.emit({
        type: 'error',
        message: text,
        retryable: false,
        ...(runId ? { runId } : {}),
      });
      this.#endOpenRuns('error', text);
    } finally {
      // A new send starts a fresh process (resuming the Claude session).
      if (this.#query === query) {
        this.#query = undefined;
        this.#input = undefined;
      }
    }
  }

  #handle(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') this.#claudeSessionId = message.session_id;
    if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      // REPLACE semantics; ambient tasks (watchers, housekeeping) are not work.
      const had = this.#background.size;
      this.#background = new Set(message.tasks.filter(task => !task.ambient).map(task => task.task_id));
      if (had && !this.#background.size && !this.#runs.length) this.#whenIdle();
      else if (this.#background.size) this.#clearIdle();
    }
    const runId = this.#runs[0];
    const stopping = this.#aborting;
    for (const event of this.#mapper.map(message, { ...(runId ? { runId } : {}), stopping })) this.#options.emit(event);
    if (message.type !== 'result' || !runId) return;
    this.#runs.shift();
    const reason: RunEndReason = this.#aborting ? 'aborted' : message.subtype === 'success' ? 'complete' : 'error';
    if (!this.#runs.length) this.#aborting = false;
    this.#options.emit({
      type: 'run.ended',
      runId,
      reason,
      ...(reason === 'error' && message.subtype !== 'success'
        ? { error: message.errors?.join('\n') || message.subtype }
        : {}),
    });
    if (!this.#runs.length) this.#whenIdle();
  }

  #closeNotice: string | undefined;
  #closeNoticed = false;
  #onClose: (() => void) | undefined;

  /** Resolves once the session is closed, or after `ms`. */
  #closedWithin(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#onClose = done;
    });
  }

  /** Say, once, on the run in flight, why the host closed the session. */
  #noticeClose(): void {
    const runId = this.#runs[0];
    if (!this.#closeNotice || !runId || this.#closeNoticed) return;
    this.#closeNoticed = true;
    this.#options.emit({
      type: 'notice',
      noticeId: this.#newId(),
      kind: 'system-reminder',
      tag: 'run-stopped',
      text: this.#closeNotice,
      runId,
    });
  }

  #endOpenRuns(reason: RunEndReason, error: string): void {
    for (const runId of this.#runs.splice(0)) {
      this.#options.emit({ type: 'run.ended', runId, reason, ...(reason === 'error' ? { error } : {}) });
    }
    this.#aborting = false;
  }
}

/**
 * Whether Claude Code ended because it was told to stop (SIGTERM, SIGINT, SIGHUP), as the SDK reports
 * it: by the signal, or by the shell-style exit code it maps to (143, 130, 129).
 */
export function stoppedBySignal(message: string): boolean {
  return /process exited with code (?:129|130|143)\b|terminated by signal SIG(?:TERM|INT|HUP)\b/.test(message);
}

/** What Claude reads: the turn's context, each in its own element, then the turn (in its notice's element). */
function turnText(input: ClaudeTurnInput): string {
  return [
    ...(input.context ?? []).map(element),
    input.notice ? element({ ...input.notice, text: input.text }) : input.text,
  ].join('\n\n');
}

/** Element and attribute names Factory writes; anything else is dropped rather than written raw. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * One piece of context as Claude reads it. Its text is escaped, so content from outside Factory (a
 * pull request comment, a card's description) can't close the element and forge another, such as a
 * `<factory-phase>` or `<skill>` block.
 */
function element(notice: ClaudeTurnNotice): string {
  const tag = NAME.test(notice.tag) ? notice.tag : 'factory-context';
  const attributes = Object.entries(notice.attributes ?? {})
    .filter(([key]) => NAME.test(key))
    .map(([key, value]) => ` ${key}="${escapeMarkup(String(value)).replaceAll('"', '&quot;')}"`)
    .join('');
  return `<${tag}${attributes}>\n${escapeMarkup(notice.text)}\n</${tag}>`;
}

function escapeMarkup(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function userContent(input: SendInput): string | Record<string, unknown>[] {
  if (!input.files?.length) return input.text;
  return [
    { type: 'text', text: input.text },
    ...input.files.map(file =>
      file.mediaType.startsWith('image/')
        ? { type: 'image', source: { type: 'base64', media_type: file.mediaType, data: stripDataUrl(file.data) } }
        : { type: 'document', source: { type: 'base64', media_type: file.mediaType, data: stripDataUrl(file.data) } },
    ),
  ];
}

function stripDataUrl(data: string): string {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  return comma >= 0 ? data.slice(comma + 1) : data;
}
