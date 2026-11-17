import { randomUUID } from 'node:crypto';

import type {
  FactoryEvent,
  InteractionRequest,
  InteractionResponse,
  MessageAttachment,
  MessageMeta,
  RunEndReason,
  ToolExit,
} from '@factory/agent-runtime';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { toPersistedErrorIdentity } from '@mastra/core/error';

import { classifyMastraCodeTool } from './tool-classification';

export const MASTRA_CODE_RUNTIME_ID = 'mastra-code';

type MastraMessage = Extract<AgentControllerEvent, { type: 'message_start' }>['message'];

/** What the mapper's own interactions ask: never `tool_input` (it names every paused tool's prompt). */
type MappedRequest = Exclude<InteractionRequest, { kind: 'tool_input' }>;

interface OpenInteraction {
  id: string;
  kind: MappedRequest['kind'];
}

/**
 * Translates one Mastra Code session's `AgentControllerEvent` stream into `FactoryEvent`s.
 *
 * Stateful: it tracks the current run, which messages and tool calls it has announced, and which
 * tool calls are parked on a human. Events that only make sense inside Mastra Code (observational
 * memory, threads, modes, goals, workspace lifecycle) produce nothing.
 *
 * Interactions are mirrored from Mastra's own approval/suspension events here. They move to
 * Factory's InteractionBroker in a later slice; until then the response recorded when the tool
 * finishes is reconstructed from its result on a best-effort basis.
 */
export class MastraCodeEventMapper {
  readonly #newRunId: () => string;
  #runId: string | undefined;
  /** The text of the latest `error` of the run, for `run.ended` (the provider's reason when it has one). */
  #lastError: string | undefined;
  readonly #contextWindow: ((modelId: string | undefined) => number | undefined) | undefined;
  /** The model the run's latest assistant reply names, so a step's usage is metered against it. */
  #replyModelId: string | undefined;
  readonly #messages = new Set<string>();
  /** The metadata last reported per open message, so `message.meta` is only sent on change. */
  readonly #messageMeta = new Map<string, string>();
  readonly #tools = new Map<string, { name: string; hasInput: boolean }>();
  readonly #exits = new Map<string, ToolExit>();
  readonly #interactions = new Map<string, OpenInteraction>(); // callId → interaction
  readonly #sessionId: string;
  readonly #now: () => Date;

  constructor(options: {
    sessionId: string;
    newRunId?: () => string;
    now?: () => Date;
    /**
     * The context window of the model the session runs now, when the host knows it (a custom
     * provider's model carries one; Mastra's catalog doesn't). Read at each model step, given the
     * model that produced it when its reply already said (else the host takes the session's model).
     */
    contextWindow?: (modelId: string | undefined) => number | undefined;
  }) {
    this.#sessionId = options.sessionId;
    this.#newRunId = options.newRunId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#contextWindow = options.contextWindow;
  }

  /** The model's context window for a usage event; a failing lookup leaves it out. */
  #window(): { contextWindow?: number } {
    try {
      const window = this.#contextWindow?.(this.#replyModelId);
      return window && Number.isFinite(window) && window > 0 ? { contextWindow: window } : {};
    } catch {
      return {};
    }
  }

  map(event: AgentControllerEvent): FactoryEvent[] {
    switch (event.type) {
      case 'agent_start': {
        const out: FactoryEvent[] = [];
        // A new run may be on another model: until its reply names one, the host's current model applies.
        this.#replyModelId = undefined;
        if (this.#runId) out.push({ type: 'run.ended', runId: this.#runId, reason: 'complete' });
        this.#runId = this.#newRunId();
        out.push({ type: 'run.started', runId: this.#runId });
        return out;
      }
      case 'agent_end': {
        if (!this.#runId) return [];
        const runId = this.#runId;
        this.#runId = undefined;
        const reason = runEndReason(event.reason);
        const error = this.#lastError;
        this.#lastError = undefined;
        return [{ type: 'run.ended', runId, reason, ...(reason === 'error' && error ? { error } : {}) }];
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
        this.#messageMeta.delete(event.id);
        return [{ type: 'message.ended', messageId: event.id }];
      }
      case 'display_state_changed': {
        // Terminal metadata (model, credential) is only visible on the display snapshot.
        const current = event.displayState?.currentMessage as MastraMessage | null | undefined;
        return current ? this.#metaUpdate(current) : [];
      }
      case 'tool_input_start':
        return this.#toolStarted(event.toolCallId, event.toolName, undefined);
      case 'tool_input_delta': {
        if (!this.#tools.has(event.toolCallId)) return [];
        const delta = typeof event.argsTextDelta === 'string' ? event.argsTextDelta : '';
        return delta ? [{ type: 'tool.input.delta', callId: event.toolCallId, delta }] : [];
      }
      case 'tool_start': {
        const known = this.#tools.get(event.toolCallId);
        if (!known) return this.#toolStarted(event.toolCallId, event.toolName, event.args);
        if (known.hasInput) return []; // re-announced after a resume
        known.hasInput = true;
        return [{ type: 'tool.input', callId: event.toolCallId, input: event.args }];
      }
      case 'shell_output':
        if (!this.#tools.has(event.toolCallId)) return [];
        return [{ type: 'tool.output', callId: event.toolCallId, stream: event.stream, chunk: event.output }];
      case 'command_exit':
        if (this.#tools.has(event.toolCallId)) {
          this.#exits.set(event.toolCallId, {
            code: event.exitCode,
            ...(event.killed ? { killed: true } : {}),
            ...(event.timedOut ? { timedOut: true } : {}),
            ...(event.error ? { error: event.error } : {}),
          });
        }
        return [];
      case 'tool_update':
        if (!this.#tools.has(event.toolCallId)) return [];
        return [{ type: 'tool.progress', callId: event.toolCallId, partial: event.partialResult }];
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
      case 'task_updated':
        return [
          {
            type: 'tasks.updated',
            tasks: event.tasks.map(task => ({
              id: task.id,
              title: task.content,
              status: task.status,
              ...(task.activeForm ? { activeTitle: task.activeForm } : {}),
            })),
          },
        ];
      case 'subagent_start':
        return [
          {
            type: 'subagent.started',
            callId: event.toolCallId,
            agentType: event.agentType,
            task: event.task,
            ...(event.modelId ? { modelId: event.modelId } : {}),
          },
        ];
      case 'subagent_end':
        return [
          {
            type: 'subagent.ended',
            callId: event.toolCallId,
            ...(event.isError ? { error: event.result } : { result: event.result }),
          },
        ];
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
            ...(event.usage.reasoningTokens !== undefined ? { reasoningTokens: event.usage.reasoningTokens } : {}),
            // `usage_update` reports one model step, so its prompt is what the model had in context
            // for that step: AI SDK's total input (cache reads and writes included; `prompt_tokens`
            // for an OpenAI-compatible provider). The window comes from the host: Mastra's model
            // catalog carries none (the registry drops models.dev's `limit.context`), but a custom
            // provider's model can.
            contextTokens: event.usage.promptTokens,
            ...optionalCount('totalTokens', event.usage.totalTokens),
            ...optionalCount('cacheCreationInputTokens', event.usage.cacheCreationInputTokens),
            ...optionalCount('cacheCreationInputTokens5m', event.usage.cacheCreationInputTokens5m),
            ...optionalCount('cacheCreationInputTokens1h', event.usage.cacheCreationInputTokens1h),
            ...this.#window(),
          },
        ];
      case 'error': {
        this.#lastError = toPersistedErrorIdentity(event.error).reason ?? event.error?.message;
        const name = event.error?.name;
        const details = {
          ...(event.errorType ? { errorType: event.errorType } : {}),
          ...(event.finishReason ? { finishReason: event.finishReason } : {}),
        };
        return [
          {
            type: 'error',
            message: event.error?.message ?? String(event.error),
            retryable: event.retryable ?? false,
            ...(name && name !== 'Error' ? { code: name } : {}),
            ...(Object.keys(details).length ? { details } : {}),
            ...(this.#runId ? { runId: this.#runId } : {}),
          },
        ];
      }
      case 'model_changed':
        this.#replyModelId = undefined;
        return [{ type: 'model.changed', runtimeId: MASTRA_CODE_RUNTIME_ID, modelId: event.modelId }];
      default:
        return [];
    }
  }

  #messageStart(message: MastraMessage): FactoryEvent[] {
    if (this.#messages.has(message.id)) return [];
    const parts = message.content?.parts ?? [];
    const runId = this.#runId ? { runId: this.#runId } : {};

    if (message.role === 'signal') {
      const signal = signalOf(message);
      // Mastra Code delivers what the user typed as a signal carrying a `data-user-message` part.
      const userTexts = parts.flatMap(part => {
        const text = userMessageText(part);
        return text ? [text] : [];
      });
      if (userTexts.length > 0) {
        this.#messages.add(message.id);
        const meta = {
          ...messageMeta(message),
          ...(signal?.attributes?.delivery === 'while-active' ? { steer: true } : {}),
        };
        return [
          {
            type: 'message.started',
            messageId: message.id,
            role: 'user',
            ...runId,
            ...(Object.keys(meta).length ? { meta } : {}),
          },
          ...userTexts.map(text => ({
            type: 'message.delta' as const,
            messageId: message.id,
            part: 'text' as const,
            delta: text,
          })),
        ];
      }
      // Every other signal is context the transcript shows as a notice (skill, environment, reminder…).
      if (!signal) return [];
      return [
        {
          type: 'notice',
          noticeId: message.id,
          kind: typeof signal.type === 'string' ? signal.type : 'signal',
          ...(typeof signal.tagName === 'string' ? { tag: signal.tagName } : {}),
          text: contentsText(signal.contents) ?? '',
          ...(signal.attributes ? { attributes: signal.attributes } : {}),
          ...runId,
        },
      ];
    }

    if (message.role !== 'user' && message.role !== 'assistant') return [];
    this.#messages.add(message.id);
    const meta = messageMeta(message);
    if (meta.modelId || meta.credentialLabel) this.#messageMeta.set(message.id, JSON.stringify(terminalMeta(meta)));
    if (message.role === 'assistant' && meta.modelId) this.#replyModelId = meta.modelId;
    const attachments = parts.flatMap(part => {
      const attachment = fileAttachment(part);
      return attachment ? [attachment] : [];
    });
    return [
      {
        type: 'message.started',
        messageId: message.id,
        role: message.role,
        ...runId,
        ...(Object.keys(meta).length ? { meta } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
      ...parts.flatMap(part => {
        const text = partText(part);
        return text
          ? [{ type: 'message.delta' as const, messageId: message.id, part: text.part, delta: text.text }]
          : [];
      }),
    ];
  }

  #metaUpdate(message: MastraMessage): FactoryEvent[] {
    if (!this.#messages.has(message.id)) return [];
    const meta = terminalMeta(messageMeta(message));
    if (!Object.keys(meta).length) return [];
    if (message.role === 'assistant' && meta.modelId) this.#replyModelId = meta.modelId;
    const key = JSON.stringify(meta);
    if (this.#messageMeta.get(message.id) === key) return [];
    this.#messageMeta.set(message.id, key);
    return [{ type: 'message.meta', messageId: message.id, meta }];
  }

  #toolStarted(callId: string, name: string, input: unknown): FactoryEvent[] {
    if (this.#tools.has(callId)) return [];
    this.#tools.set(callId, { name, hasInput: input !== undefined });
    const { category, executor } = classifyMastraCodeTool(name);
    return [
      {
        type: 'tool.started',
        callId,
        name,
        category,
        executor,
        ...(input !== undefined ? { input } : {}),
        ...(this.#runId ? { runId: this.#runId } : {}),
      },
    ];
  }

  #toolEnd(event: Extract<AgentControllerEvent, { type: 'tool_end' }>): FactoryEvent[] {
    if (!this.#tools.has(event.toolCallId)) return [];
    this.#tools.delete(event.toolCallId);
    const exit = this.#exits.get(event.toolCallId);
    this.#exits.delete(event.toolCallId);
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

    out.push({
      type: 'tool.ended',
      callId: event.toolCallId,
      ...(event.denied
        ? { denied: true }
        : event.isError
          ? { error: errorText(event.result) }
          : { result: event.result }),
      ...(exit ? { exit } : {}),
    });
    return out;
  }

  #requestInteraction(callId: string, request: MappedRequest): FactoryEvent[] {
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

function optionalCount<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return typeof value === 'number' ? ({ [key]: value } as { [P in K]?: number }) : {};
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

interface SignalPayload {
  type?: unknown;
  tagName?: unknown;
  contents?: unknown;
  attributes?: Record<string, unknown>;
}

/** The signal payload: on `content.metadata.signal`, or the first `data-*` part's data. */
function signalOf(message: MastraMessage): SignalPayload | undefined {
  const fromMetadata = message.content?.metadata?.signal;
  if (isRecord(fromMetadata)) return normalizeSignal(fromMetadata);
  const parts: unknown[] = message.content?.parts ?? [];
  const part = parts.find(p => isRecord(p) && typeof p.type === 'string' && p.type.startsWith('data-'));
  const data = isRecord(part) ? part.data : undefined;
  return isRecord(data) ? normalizeSignal(data) : undefined;
}

function normalizeSignal(raw: Record<string, unknown>): SignalPayload {
  return {
    type: raw.type,
    tagName: raw.tagName,
    contents: raw.contents,
    attributes: isRecord(raw.attributes) ? raw.attributes : undefined,
  };
}

/** Text of signal `contents`: a string, or an array of strings / `{ text }`. */
function contentsText(contents: unknown): string | undefined {
  if (typeof contents === 'string') return contents || undefined;
  if (!Array.isArray(contents)) return undefined;
  const text = contents
    .map(entry =>
      typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.text === 'string' ? entry.text : '',
    )
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

/** Text of a `data-user-message` part. */
function userMessageText(part: unknown): string | undefined {
  if (!isRecord(part) || part.type !== 'data-user-message' || !isRecord(part.data)) return undefined;
  return contentsText(part.data.contents);
}

/** The model/credential subset of the metadata, which Mastra fills in when a reply finishes. */
function terminalMeta({ modelId, credentialLabel, credentialOwnerId }: MessageMeta): MessageMeta {
  return {
    ...(modelId ? { modelId } : {}),
    ...(credentialLabel ? { credentialLabel } : {}),
    ...(credentialOwnerId ? { credentialOwnerId } : {}),
  };
}

/** Who sent the message and what produced it, wherever Mastra stamped it. */
function messageMeta(message: MastraMessage): MessageMeta {
  const meta: MessageMeta = {};
  const metadata = isRecord(message.content?.metadata) ? message.content.metadata : {};
  const modelId = str(metadata.modelId);
  const credentialLabel = str(metadata.credentialLabel);
  const credentialOwnerId = str(metadata.credentialOwnerId);
  if (modelId) meta.modelId = modelId;
  if (credentialLabel) meta.credentialLabel = credentialLabel;
  if (credentialOwnerId) meta.credentialOwnerId = credentialOwnerId;

  const mastra = mastraOptions(message);
  if (mastra) {
    const author = isRecord(mastra.author) ? mastra.author : undefined;
    const authorId = str(author?.id);
    if (authorId) {
      const name = str(author?.name);
      const avatarUrl = str(author?.avatarUrl);
      meta.author = { id: authorId, ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
    }
    const channels = isRecord(mastra.channels) ? mastra.channels : undefined;
    const platform = channels ? Object.keys(channels)[0] : undefined;
    if (channels && platform) {
      const info = channels[platform];
      const channelAuthor = isRecord(info) && isRecord(info.author) ? info.author : undefined;
      const userId = str(channelAuthor?.userId);
      const authorName = str(channelAuthor?.fullName) ?? str(channelAuthor?.userName);
      meta.channel = { platform, ...(userId ? { userId } : {}), ...(authorName ? { authorName } : {}) };
    }
  }
  return meta;
}

/** Provider options under `mastra`: on the message, the signal envelope, or the live data part. */
function mastraOptions(message: MastraMessage): Record<string, unknown> | undefined {
  const signal = message.content?.metadata?.signal;
  const parts: unknown[] = message.content?.parts ?? [];
  const dataPart = parts.find(part => isRecord(part) && part.type === 'data-user-message');
  const candidates = [
    message.content?.providerMetadata,
    isRecord(signal) ? signal.providerOptions : undefined,
    isRecord(dataPart) && isRecord(dataPart.data) ? dataPart.data.providerOptions : undefined,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && isRecord(candidate.mastra)) return candidate.mastra;
  }
  return undefined;
}

function fileAttachment(part: unknown): MessageAttachment | undefined {
  if (!isRecord(part) || part.type !== 'file') return undefined;
  const mediaType = str(part.mediaType) ?? str(part.mimeType);
  const url = str(part.url) ?? str(part.data);
  if (!mediaType || !url) return undefined;
  const name = str(part.filename) ?? str(part.name);
  return { mediaType, url, ...(name ? { name } : {}) };
}

function partText(part: unknown): { part: 'text' | 'reasoning'; text: string } | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type === 'text' && typeof part.text === 'string' && part.text) return { part: 'text', text: part.text };
  if (part.type === 'reasoning') {
    const text = typeof part.reasoning === 'string' ? part.reasoning : typeof part.text === 'string' ? part.text : '';
    if (text) return { part: 'reasoning', text };
  }
  return undefined;
}

function suspensionRequest(toolName: string, args: unknown, payload: unknown): MappedRequest {
  const input = isRecord(args) ? args : {};
  if (toolName === 'submit_plan') {
    return { kind: 'plan_approval', planPath: typeof input.path === 'string' ? input.path : '' };
  }
  if (toolName === 'ask_user') {
    const options = Array.isArray(input.options)
      ? input.options.flatMap(option =>
          isRecord(option) && typeof option.label === 'string'
            ? [
                {
                  label: option.label,
                  description: typeof option.description === 'string' ? option.description : undefined,
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
  const message = isRecord(payload) ? payload.message : undefined;
  return { kind: 'question', question: typeof message === 'string' ? message : `${toolName} is waiting for input` };
}

function inferResponse(kind: MappedRequest['kind'], result: unknown, denied: boolean): InteractionResponse {
  switch (kind) {
    case 'tool_approval':
      return { kind, approved: !denied };
    case 'plan_approval': {
      const submitted = isRecord(result) && isRecord(result.submittedPlan) ? result.submittedPlan : undefined;
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
  if (isRecord(result)) {
    const message = result.message ?? result.error;
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(result) ?? 'error';
}
