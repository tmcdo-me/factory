import { randomUUID } from 'node:crypto';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FactoryEvent, RunEndReason, SendInput } from '@factory/agent-runtime';

import { ClaudeAgentEventMapper } from './event-mapper';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeAgentSessionOptions {
  sessionId: string;
  /** The session's working directory (its checkout). */
  cwd: string;
  emit(event: FactoryEvent): void;
  model?: string;
  /** Factory's instructions, appended to Claude Code's own system prompt. */
  instructions?: string;
  /** Claude Code session id to resume (from `runtimeState()`). */
  resume?: string;
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
  async send(input: SendInput): Promise<{ runId: string }> {
    if (this.#closed) throw new Error(`Session ${this.id} is closed`);
    const runId = this.#newId();
    const messageId = this.#newId();
    this.#runs.push(runId);
    this.#options.emit({ type: 'run.started', runId });
    this.#options.emit({ type: 'message.started', messageId, role: 'user', runId });
    this.#options.emit({ type: 'message.delta', messageId, part: 'text', delta: input.text });
    this.#options.emit({ type: 'message.ended', messageId });
    this.#start();
    this.#input!.push({
      type: 'user',
      message: { role: 'user', content: userContent(input) },
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
        settingSources: ['project'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(options.instructions ? { append: options.instructions } : {}),
        },
        // Claude Code's own question tool has no human on the other end yet; Factory's lands later.
        disallowedTools: ['AskUserQuestion'],
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
