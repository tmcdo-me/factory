import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FactoryEvent, TaskSnapshot } from '@factory/agent-runtime';

import { SUBAGENT_TOOLS, TODO_TOOL, classifyClaudeTool, factoryToolName } from './tool-classification';

export const CLAUDE_AGENT_RUNTIME_ID = 'claude-agent';

type Json = Record<string, unknown>;

interface StreamState {
  messageId: string;
  /** Content block index → what it is (text/thinking, or a tool call id). */
  blocks: Map<number, { kind: 'text' | 'thinking' } | { kind: 'tool'; callId: string }>;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Translates the Claude Agent SDK's message stream (with `includePartialMessages`) into
 * `FactoryEvent`s. Live text, thinking and tool-argument deltas come from `stream_event`s; the full
 * `assistant` message that follows supplies parsed tool inputs (and everything, when a message was
 * not streamed). Tool results arrive in `user` messages. Calls made by subagents carry
 * `parentCallId`; a subagent's own prose stays inside the subagent.
 *
 * Runs are the session's business: it passes the current `runId`, and `result` messages produce
 * usage and errors here while the session closes the run.
 */
export class ClaudeAgentEventMapper {
  /** Live stream per channel: `''` for the main agent, else the parent tool call id. */
  readonly #streams = new Map<string, StreamState>();
  readonly #messages = new Set<string>();
  readonly #inputSeen = new Set<string>();
  readonly #tools = new Map<string, string>(); // callId → tool name
  readonly #subagents = new Set<string>();
  /** The main agent's latest model call: its model and the size of the prompt it sent. */
  #lastCall: { model?: string; contextTokens?: number } = {};

  /**
   * `stopping` is true while Factory is interrupting the turn (the person pressed stop). What Claude
   * Code then reports as failures (the interrupted tool's result, the turn's `error_during_execution`)
   * is the stop itself, not an error.
   */
  map(message: SDKMessage, context: { runId?: string; stopping?: boolean } = {}): FactoryEvent[] {
    const runId = context.runId ? { runId: context.runId } : {};
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.#lastCall = { ...this.#lastCall, model: message.model };
          return [{ type: 'model.changed', runtimeId: CLAUDE_AGENT_RUNTIME_ID, modelId: message.model }];
        }
        return [];
      case 'stream_event':
        return this.#streamEvent(message.event as unknown as Json, message.parent_tool_use_id, runId);
      case 'assistant':
        return this.#assistant(message, runId);
      case 'user':
        return this.#toolResults(message, context.stopping === true);
      case 'result': {
        const usage = message.usage as unknown as Json;
        const { contextTokens } = this.#lastCall;
        const contextWindow = this.#contextWindow(message.modelUsage);
        const out: FactoryEvent[] = [
          {
            type: 'usage',
            ...runId,
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            ...(typeof usage.cache_read_input_tokens === 'number'
              ? { cachedInputTokens: usage.cache_read_input_tokens }
              : {}),
            costUsd: message.total_cost_usd,
            // fork(claude-agent): the context meter's numbers.
            ...(contextTokens !== undefined ? { contextTokens } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          },
        ];
        // An interrupted turn ends with `error_during_execution`; when Factory stopped it, that is the stop.
        if (message.subtype !== 'success' && !(context.stopping && message.subtype === 'error_during_execution')) {
          out.push({
            type: 'error',
            message: message.errors?.join('\n') || message.subtype,
            retryable: false,
            code: message.subtype,
            ...runId,
          });
        }
        return out;
      }
      default:
        return [];
    }
  }

  #streamEvent(event: Json, parent: string | null, runId: { runId?: string }): FactoryEvent[] {
    const channel = parent ?? '';
    switch (event.type) {
      case 'message_start': {
        const started = event.message as Json | undefined;
        const id = str(started?.id);
        if (!started || !id) return [];
        if (!parent) this.#recordCall(started);
        this.#streams.set(channel, { messageId: id, blocks: new Map() });
        // A subagent's prose stays inside the subagent; only the main agent speaks in the transcript.
        if (parent || this.#messages.has(id)) return [];
        this.#messages.add(id);
        return [{ type: 'message.started', messageId: id, role: 'assistant', ...runId }];
      }
      case 'content_block_start': {
        const stream = this.#streams.get(channel);
        const block = event.content_block as Json | undefined;
        const index = Number(event.index);
        if (!stream || !block) return [];
        if (block.type === 'text' || block.type === 'thinking') {
          stream.blocks.set(index, { kind: block.type });
          return [];
        }
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          stream.blocks.set(index, { kind: 'tool', callId: block.id });
          return this.#toolStarted(block.id, block.name, undefined, parent, runId);
        }
        return [];
      }
      case 'content_block_delta': {
        const stream = this.#streams.get(channel);
        const block = stream?.blocks.get(Number(event.index));
        const delta = event.delta as Json | undefined;
        if (!stream || !block || !delta) return [];
        if (block.kind === 'tool') {
          const partial = str(delta.partial_json);
          return partial ? [{ type: 'tool.input.delta', callId: block.callId, delta: partial }] : [];
        }
        if (parent) return [];
        if (delta.type === 'text_delta' && str(delta.text)) {
          return [{ type: 'message.delta', messageId: stream.messageId, part: 'text', delta: delta.text as string }];
        }
        if (delta.type === 'thinking_delta' && str(delta.thinking)) {
          return [
            { type: 'message.delta', messageId: stream.messageId, part: 'reasoning', delta: delta.thinking as string },
          ];
        }
        return [];
      }
      case 'message_stop': {
        const stream = this.#streams.get(channel);
        this.#streams.delete(channel);
        if (!stream || parent) return [];
        return [{ type: 'message.ended', messageId: stream.messageId }];
      }
      default:
        return [];
    }
  }

  #assistant(message: Extract<SDKMessage, { type: 'assistant' }>, runId: { runId?: string }): FactoryEvent[] {
    const parent = message.parent_tool_use_id;
    const body = message.message as unknown as Json;
    const id = str(body.id) ?? message.uuid;
    const content = Array.isArray(body.content) ? (body.content as Json[]) : [];
    if (!parent) this.#recordCall(body);
    const out: FactoryEvent[] = [];
    // Not streamed (partial messages off, or a replay): announce it from the full message.
    const streamed = this.#messages.has(id);
    if (!parent && !streamed) {
      this.#messages.add(id);
      out.push({ type: 'message.started', messageId: id, role: 'assistant', ...runId });
    }
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        out.push(...this.#toolStarted(block.id, block.name, block.input, parent, runId));
        out.push(...this.#toolInput(block.id, block.name, block.input));
      } else if (!parent && !streamed && block.type === 'text' && str(block.text)) {
        out.push({ type: 'message.delta', messageId: id, part: 'text', delta: block.text as string });
      } else if (!parent && !streamed && block.type === 'thinking' && str(block.thinking)) {
        out.push({ type: 'message.delta', messageId: id, part: 'reasoning', delta: block.thinking as string });
      }
    }
    if (!parent && !streamed) out.push({ type: 'message.ended', messageId: id });
    if (message.error) {
      out.push({
        type: 'error',
        message: String(message.error),
        retryable: message.error === 'rate_limit',
        code: String(message.error),
        ...runId,
      });
    }
    return out;
  }

  /**
   * Remember the main agent's latest model call (a subagent has a context of its own).
   *
   * What is "in context" is the prompt that call sent: uncached input plus cache-read plus
   * cache-written input. Anthropic splits a prompt across those three, so `input_tokens` alone is
   * only the uncached tail. It is not the `result` message's usage either: that adds up every call
   * of the turn, counting the shared prefix once per call. The call's own output joins the context
   * on the next call and is counted then. (`Query.getContextUsage()` gives Claude Code's exact
   * breakdown, but it is a control request the session would have to make; this needs none.)
   */
  #recordCall(message: Json): void {
    const usage = isRecord(message.usage) ? message.usage : {};
    const input = num(usage.input_tokens);
    const contextTokens =
      input === undefined
        ? this.#lastCall.contextTokens
        : input + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0);
    this.#lastCall = { model: str(message.model) ?? this.#lastCall.model, contextTokens };
  }

  /**
   * The context window Claude Code reports for the main agent's model. `modelUsage` is keyed by
   * model id and also holds subagent and helper models, so pick the main agent's entry, falling
   * back to the only entry. Nothing is guessed when that is ambiguous.
   */
  #contextWindow(modelUsage: Record<string, { contextWindow?: number; canonicalModel?: string }> | undefined) {
    if (!modelUsage) return undefined;
    const model = this.#lastCall.model;
    const entries = Object.entries(modelUsage);
    const entry =
      (model !== undefined
        ? (modelUsage[model] ?? entries.find(([, usage]) => usage.canonicalModel === model)?.[1])
        : undefined) ?? (entries.length === 1 ? entries[0]![1] : undefined);
    const window = entry?.contextWindow;
    return typeof window === 'number' && window > 0 ? window : undefined;
  }

  #toolStarted(
    callId: string,
    name: string,
    input: unknown,
    parent: string | null,
    runId: { runId?: string },
  ): FactoryEvent[] {
    if (this.#tools.has(callId)) return [];
    this.#tools.set(callId, name);
    const { category, executor } = classifyClaudeTool(name);
    return [
      {
        type: 'tool.started',
        callId,
        name: factoryToolName(name),
        category,
        executor,
        ...(input !== undefined ? { input } : {}),
        ...runId,
        ...(parent ? { parentCallId: parent } : {}),
      },
    ];
  }

  /** The parsed arguments, once; plus what they mean for subagents and the task list. */
  #toolInput(callId: string, name: string, input: unknown): FactoryEvent[] {
    if (this.#inputSeen.has(callId)) return [];
    this.#inputSeen.add(callId);
    const out: FactoryEvent[] = [{ type: 'tool.input', callId, input }];
    const args = isRecord(input) ? input : {};
    if (SUBAGENT_TOOLS.has(name)) {
      this.#subagents.add(callId);
      out.push({
        type: 'subagent.started',
        callId,
        agentType: str(args.subagent_type) ?? 'general-purpose',
        task: str(args.description) ?? str(args.prompt) ?? '',
        ...(str(args.model) ? { modelId: str(args.model) } : {}),
      });
    }
    if (name === TODO_TOOL && Array.isArray(args.todos)) {
      out.push({ type: 'tasks.updated', tasks: args.todos.flatMap((todo, index) => taskOf(todo, index)) });
    }
    return out;
  }

  #toolResults(message: Extract<SDKMessage, { type: 'user' }>, stopping: boolean): FactoryEvent[] {
    const content = (message.message as unknown as Json).content;
    if (!Array.isArray(content)) return [];
    const out: FactoryEvent[] = [];
    for (const block of content as Json[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const callId = block.tool_use_id;
      if (!this.#tools.has(callId)) continue;
      this.#tools.delete(callId);
      const text = resultText(block.content);
      const structured = message.tool_use_result;
      // Bash and friends report stdout/stderr separately; show them as the command's output.
      if (isRecord(structured)) {
        if (str(structured.stdout))
          out.push({ type: 'tool.output', callId, stream: 'stdout', chunk: structured.stdout as string });
        if (str(structured.stderr))
          out.push({ type: 'tool.output', callId, stream: 'stderr', chunk: structured.stderr as string });
      }
      out.push(
        block.is_error === true
          ? // The interrupted tool's result is Claude Code's own rejection text; show the stop instead.
            stopping
            ? { type: 'tool.ended', callId, error: 'Stopped', stopped: true }
            : { type: 'tool.ended', callId, error: text || 'Tool failed' }
          : { type: 'tool.ended', callId, result: structured ?? text },
      );
      if (this.#subagents.delete(callId)) {
        out.push(
          block.is_error === true
            ? { type: 'subagent.ended', callId, error: stopping ? 'Stopped' : text || 'Subagent failed' }
            : { type: 'subagent.ended', callId, result: text },
        );
      }
    }
    return out;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n');
}

function taskOf(todo: unknown, index: number): TaskSnapshot[] {
  if (!isRecord(todo) || typeof todo.content !== 'string') return [];
  const status = todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending';
  return [
    {
      id: str(todo.id) ?? String(index + 1),
      title: todo.content,
      status,
      ...(str(todo.activeForm) ? { activeTitle: todo.activeForm as string } : {}),
    },
  ];
}
