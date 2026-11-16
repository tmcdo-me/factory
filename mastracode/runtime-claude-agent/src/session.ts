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

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeAgentSessionOptions {
  sessionId: string;
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
  /** Subprocess environment; build it with `claudeProcessEnv`. */
  env: Record<string, string>;
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
    this.#start();
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#input?.close();
    this.#query?.close();
    await this.#pump?.catch(() => undefined);
    this.#endOpenRuns('aborted', 'Session closed');
  }

  #start(): void {
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
        env: options.env,
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
    this.#pump = this.#drain(query);
  }

  async #drain(query: Query): Promise<void> {
    try {
      for await (const message of query) this.#handle(message);
      this.#endOpenRuns('error', 'Claude Code exited');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.#options.emit({
        type: 'error',
        message: text,
        retryable: false,
        ...(this.#runs[0] ? { runId: this.#runs[0] } : {}),
      });
      this.#endOpenRuns(this.#closed ? 'aborted' : 'error', text);
    } finally {
      // A new send starts a fresh process (resuming the Claude session).
      this.#query = undefined;
      this.#input = undefined;
    }
  }

  #handle(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') this.#claudeSessionId = message.session_id;
    const runId = this.#runs[0];
    for (const event of this.#mapper.map(message, runId ? { runId } : {})) this.#options.emit(event);
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
  }

  #endOpenRuns(reason: RunEndReason, error: string): void {
    for (const runId of this.#runs.splice(0)) {
      this.#options.emit({ type: 'run.ended', runId, reason, ...(reason === 'error' ? { error } : {}) });
    }
    this.#aborting = false;
  }
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
