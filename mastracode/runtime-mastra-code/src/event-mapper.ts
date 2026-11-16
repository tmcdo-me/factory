import { randomUUID } from 'node:crypto';

import type { FactoryEvent, InteractionRequest, InteractionResponse, RunEndReason } from '@factory/agent-runtime';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import { classifyMastraCodeTool } from './tool-classification';

export const MASTRA_CODE_RUNTIME_ID = 'mastra-code';

interface OpenInteraction {
  id: string;
  kind: InteractionRequest['kind'];
}

/**
 * Translates one Mastra Code session's `AgentControllerEvent` stream into `FactoryEvent`s.
 *
 * Stateful: it tracks the current run, which messages and tool calls it has announced, and which
 * tool calls are parked on a human. Events that only make sense inside Mastra Code (observational
 * memory, threads, display state, tasks, goals, subagents, workspace lifecycle) produce nothing.
 *
 * Interactions are mirrored from Mastra's own approval/suspension events here. They move to
 * Factory's InteractionBroker in a later slice; until then the response recorded when the tool
 * finishes is reconstructed from its result on a best-effort basis.
 */
export class MastraCodeEventMapper {
  readonly #newRunId: () => string;
  #runId: string | undefined;
  readonly #messages = new Set<string>();
  readonly #tools = new Map<string, string>(); // callId → tool name
  readonly #interactions = new Map<string, OpenInteraction>(); // callId → interaction
  readonly #sessionId: string;
  readonly #now: () => Date;

  constructor(options: { sessionId: string; newRunId?: () => string; now?: () => Date }) {
    this.#sessionId = options.sessionId;
    this.#newRunId = options.newRunId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  map(event: AgentControllerEvent): FactoryEvent[] {
    switch (event.type) {
      case 'agent_start': {
        const out: FactoryEvent[] = [];
        if (this.#runId) out.push({ type: 'run.ended', runId: this.#runId, reason: 'complete' });
        this.#runId = this.#newRunId();
        out.push({ type: 'run.started', runId: this.#runId });
        return out;
      }
      case 'agent_end': {
        if (!this.#runId) return [];
        const runId = this.#runId;
        this.#runId = undefined;
        return [{ type: 'run.ended', runId, reason: runEndReason(event.reason) }];
      }
      case 'message_start':
        return this.#messageStart(event.message);
      case 'message_update': {
        if (!this.#messages.has(event.id)) return [];
        const update = event.event;
        if (update.type === 'text-delta') {
          return [{ type: 'message.delta', messageId: event.id, part: 'text', delta: update.delta }];
        }
        if (update.type === 'reasoning-delta') {
          return [{ type: 'message.delta', messageId: event.id, part: 'reasoning', delta: update.delta }];
        }
        return []; // non-text parts: tool calls arrive as tool_* events
      }
      case 'message_end': {
        if (!this.#messages.delete(event.id)) return [];
        return [{ type: 'message.ended', messageId: event.id }];
      }
      case 'tool_start': {
        if (this.#tools.has(event.toolCallId)) return []; // re-announced after a resume
        this.#tools.set(event.toolCallId, event.toolName);
        const { category, executor } = classifyMastraCodeTool(event.toolName);
        return [
          {
            type: 'tool.started',
            callId: event.toolCallId,
            name: event.toolName,
            category,
            executor,
            input: event.args,
            ...(this.#runId ? { runId: this.#runId } : {}),
          },
        ];
      }
      case 'shell_output':
        if (!this.#tools.has(event.toolCallId)) return [];
        return [{ type: 'tool.output', callId: event.toolCallId, stream: event.stream, chunk: event.output }];
      case 'tool_end':
        return this.#toolEnd(event);
      case 'tool_approval_required':
        return this.#requestInteraction(event.toolCallId, {
          kind: 'tool_approval',
          toolName: event.toolName,
          input: event.args,
        });
      case 'tool_suspended':
        return this.#requestInteraction(
          event.toolCallId,
          suspensionRequest(event.toolName, event.args, event.suspendPayload),
        );
      case 'tool_suspension_cancelled': {
        const open = this.#interactions.get(event.toolCallId);
        if (!open) return [];
        this.#interactions.delete(event.toolCallId);
        return [{ type: 'interaction.cancelled', interactionId: open.id, reason: event.reason }];
      }
      case 'usage_update':
        return [
          {
            type: 'usage',
            ...(this.#runId ? { runId: this.#runId } : {}),
            inputTokens: event.usage.promptTokens,
            outputTokens: event.usage.completionTokens,
            ...(event.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.usage.cachedInputTokens }
              : {}),
          },
        ];
      case 'error':
        return [
          {
            type: 'error',
            message: event.error?.message ?? String(event.error),
            retryable: event.retryable ?? false,
            ...(this.#runId ? { runId: this.#runId } : {}),
          },
        ];
      case 'model_changed':
        return [{ type: 'model.changed', runtimeId: MASTRA_CODE_RUNTIME_ID, modelId: event.modelId }];
      default:
        return [];
    }
  }

  #messageStart(message: Extract<AgentControllerEvent, { type: 'message_start' }>['message']): FactoryEvent[] {
    if (this.#messages.has(message.id)) return [];
    const parts = message.content?.parts ?? [];

    let role: 'user' | 'assistant';
    let texts: { part: 'text' | 'reasoning'; text: string }[];
    if (message.role === 'signal') {
      // Mastra Code delivers what the user typed as a signal carrying a `data-user-message` part.
      // Other signals (`data-signal`, `data-system-reminder`) are system context, not transcript.
      texts = parts.flatMap(part => {
        const text = userMessageText(part);
        return text ? [{ part: 'text' as const, text }] : [];
      });
      if (texts.length === 0) return [];
      role = 'user';
    } else if (message.role === 'user' || message.role === 'assistant') {
      role = message.role;
      texts = parts.flatMap(part => {
        const text = partText(part);
        return text ? [text] : [];
      });
    } else {
      return [];
    }

    this.#messages.add(message.id);
    return [
      { type: 'message.started', messageId: message.id, role, ...(this.#runId ? { runId: this.#runId } : {}) },
      ...texts.map(({ part, text }) => ({ type: 'message.delta' as const, messageId: message.id, part, delta: text })),
    ];
  }

  #toolEnd(event: Extract<AgentControllerEvent, { type: 'tool_end' }>): FactoryEvent[] {
    if (!this.#tools.has(event.toolCallId)) return [];
    this.#tools.delete(event.toolCallId);
    const out: FactoryEvent[] = [];

    const open = this.#interactions.get(event.toolCallId);
    if (open) {
      this.#interactions.delete(event.toolCallId);
      out.push({
        type: 'interaction.resolved',
        interactionId: open.id,
        response: inferResponse(open.kind, event.result, event.denied === true),
      });
    }

    const error = event.denied ? 'denied' : event.isError ? errorText(event.result) : undefined;
    out.push({
      type: 'tool.ended',
      callId: event.toolCallId,
      ...(error === undefined ? { result: event.result } : { error }),
    });
    return out;
  }

  #requestInteraction(callId: string, request: InteractionRequest): FactoryEvent[] {
    if (this.#interactions.has(callId)) return [];
    const id = `${request.kind}:${callId}`;
    this.#interactions.set(callId, { id, kind: request.kind });
    return [
      {
        type: 'interaction.requested',
        interaction: { id, sessionId: this.#sessionId, callId, request, requestedAt: this.#now().toISOString() },
      },
    ];
  }
}

function runEndReason(reason: Extract<AgentControllerEvent, { type: 'agent_end' }>['reason']): RunEndReason {
  switch (reason) {
    case 'aborted':
      return 'aborted';
    case 'error':
      return 'error';
    case 'suspended':
      return 'awaiting_interaction';
    default:
      return 'complete';
  }
}

function partText(part: unknown): { part: 'text' | 'reasoning'; text: string } | undefined {
  if (!part || typeof part !== 'object') return undefined;
  const p = part as { type?: unknown; text?: unknown; reasoning?: unknown };
  if (p.type === 'text' && typeof p.text === 'string' && p.text) return { part: 'text', text: p.text };
  if (p.type === 'reasoning') {
    const text = typeof p.reasoning === 'string' ? p.reasoning : typeof p.text === 'string' ? p.text : '';
    if (text) return { part: 'reasoning', text };
  }
  return undefined;
}

/** Text of a `data-user-message` part (`contents` is a string or an array of strings / `{ text }`). */
function userMessageText(part: unknown): string | undefined {
  if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'data-user-message') return undefined;
  const contents = ((part as { data?: unknown }).data as { contents?: unknown } | undefined)?.contents;
  if (typeof contents === 'string') return contents || undefined;
  if (!Array.isArray(contents)) return undefined;
  const text = contents
    .map(entry =>
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string'
          ? (entry as { text: string }).text
          : '',
    )
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function suspensionRequest(toolName: string, args: unknown, payload: unknown): InteractionRequest {
  const input = (args ?? {}) as Record<string, unknown>;
  if (toolName === 'submit_plan') {
    return { kind: 'plan_approval', planPath: typeof input.path === 'string' ? input.path : '' };
  }
  if (toolName === 'ask_user') {
    const options = Array.isArray(input.options)
      ? input.options.flatMap(option =>
          option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string'
            ? [
                {
                  label: (option as { label: string }).label,
                  description: (option as { description?: string }).description,
                },
              ]
            : [],
        )
      : undefined;
    return {
      kind: 'question',
      question: typeof input.question === 'string' ? input.question : '',
      ...(options?.length ? { options } : {}),
      ...(input.selectionMode === 'multi_select' ? { selection: 'multiple' as const } : {}),
    };
  }
  const message = payload && typeof payload === 'object' ? (payload as { message?: unknown }).message : undefined;
  return { kind: 'question', question: typeof message === 'string' ? message : `${toolName} is waiting for input` };
}

function inferResponse(kind: InteractionRequest['kind'], result: unknown, denied: boolean): InteractionResponse {
  switch (kind) {
    case 'tool_approval':
      return { kind, approved: !denied };
    case 'plan_approval': {
      const submitted = (result as { submittedPlan?: { action?: unknown; feedback?: unknown } } | undefined)
        ?.submittedPlan;
      return {
        kind,
        action: submitted?.action === 'approved' ? 'approved' : 'rejected',
        ...(typeof submitted?.feedback === 'string' ? { feedback: submitted.feedback } : {}),
      };
    }
    case 'question':
      return { kind, answer: typeof result === 'string' ? result : JSON.stringify(result ?? '') };
  }
}

function errorText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const message = (result as { message?: unknown; error?: unknown }).message ?? (result as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(result) ?? 'error';
}
