// fork(claude-agent): project Factory's runtime-neutral transcript onto the chat timeline.
/**
 * The chat renderers (MessageBubble, ToolFactory, prompt cards, signal rows) take the timeline
 * entry shapes the Mastra reducer in `transcript.ts` builds. This projection builds the same shapes
 * from a `Transcript` (`@factory/agent-runtime`), so a session can be drawn from Factory's own event
 * log, whatever runtime produced it, without touching the renderers. Renderers can move to native
 * transcript items one at a time later; this file is the only place that knows both shapes.
 */
import type { AgentControllerTaskSnapshot } from '@mastra/client-js';
import type { MastraDBMessage, MastraMessagePart } from './message-types';
import type {
  InteractionItem,
  MessageItem,
  NoticeItem,
  SubagentItem,
  ToolItem,
  Transcript,
} from '@factory/agent-runtime/browser';

import type { MessageEntry, PromptEntry, TimelineEntry, ToolCall } from './transcript';

export interface ProjectedTranscript {
  entries: TimelineEntry[];
  /** A run is in progress. */
  running: boolean;
  tasks: AgentControllerTaskSnapshot[];
}

type Part = MastraMessagePart;

export function projectTranscript(transcript: Transcript): ProjectedTranscript {
  const entries: TimelineEntry[] = [];
  const tools = new Map(transcript.items.flatMap(item => (item.kind === 'tool' ? [[item.callId, item] as const] : [])));
  /** The assistant entry tool calls of the current run attach to. */
  let anchor: { entry: MessageEntry; runId?: string } | undefined;
  let running = false;

  const attachTool = (tool: ToolItem) => {
    if (!anchor || anchor.runId !== tool.runId) {
      const entry = assistantEntry(`assistant-tools-${tool.callId}`, tool.startedAt, [], false);
      entries.push(entry);
      anchor = { entry, runId: tool.runId };
    }
    const { entry } = anchor;
    entry.message.content.parts.push(toolPart(tool));
    entry.runtimeTools = { ...entry.runtimeTools, [tool.callId]: toolCall(tool) };
    if (tool.status === 'running') entry.streaming = true;
  };

  for (const item of transcript.items) {
    switch (item.kind) {
      case 'run':
        running = item.status === 'running';
        if (item.status === 'running') anchor = undefined;
        break;
      case 'message': {
        const entry = messageEntry(item);
        entries.push(entry);
        anchor = item.role === 'assistant' ? { entry, runId: item.runId } : undefined;
        break;
      }
      case 'tool':
        attachTool(item);
        break;
      case 'interaction': {
        const prompt = promptEntry(item, tools.get(item.interaction.callId ?? ''));
        if (prompt) entries.push(prompt);
        break;
      }
      case 'notice':
        entries.push(noticeEntry(item));
        break;
      case 'subagent':
        entries.push(subagentEntry(item));
        break;
      case 'error':
        entries.push({
          kind: 'notice',
          id: `error-${entries.length}-${item.at}`,
          level: 'error',
          text: item.message,
          ...(item.code ? { error: { name: item.code, message: item.message } } : {}),
        });
        break;
    }
  }

  return {
    entries,
    running,
    tasks: transcript.tasks.map(task => ({
      id: task.id,
      content: task.title,
      status: task.status,
      activeForm: task.activeTitle ?? task.title,
    })),
  };
}

function assistantEntry(id: string, startedAt: string, parts: Part[], streaming: boolean): MessageEntry {
  return {
    kind: 'message',
    id,
    message: {
      id,
      role: 'assistant',
      createdAt: new Date(startedAt),
      content: { format: 2, parts },
    },
    ...(streaming ? { streaming: true } : {}),
  };
}

function messageEntry(item: MessageItem): MessageEntry {
  const parts: Part[] = item.parts.map(part =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'reasoning', reasoning: part.text, details: [{ type: 'text', text: part.text }] },
  );
  for (const attachment of item.attachments ?? []) {
    parts.push({
      type: 'file',
      mimeType: attachment.mediaType,
      mediaType: attachment.mediaType,
      data: attachment.url,
      ...(attachment.name ? { filename: attachment.name } : {}),
    } as unknown as Part);
  }

  const meta = item.meta;
  const metadata: Record<string, unknown> = {};
  if (meta?.modelId) metadata.modelId = meta.modelId;
  if (meta?.credentialLabel) metadata.credentialLabel = meta.credentialLabel;
  if (meta?.credentialOwnerId) metadata.credentialOwnerId = meta.credentialOwnerId;
  const mastra: Record<string, unknown> = {};
  if (meta?.author) mastra.author = meta.author;
  if (meta?.channel) {
    mastra.channels = {
      [meta.channel.platform]: { author: { userId: meta.channel.userId, fullName: meta.channel.authorName } },
    };
  }

  const message = {
    id: item.messageId,
    role: item.role,
    createdAt: new Date(item.startedAt),
    content: {
      format: 2,
      parts,
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...(Object.keys(mastra).length ? { providerMetadata: { mastra } } : {}),
    },
  } as MastraDBMessage;

  return {
    kind: 'message',
    id: item.messageId,
    message,
    ...(item.role === 'assistant' && !item.complete ? { streaming: true } : {}),
    ...(meta?.steer ? { steer: true, deliveryStatus: 'delivered' as const } : {}),
  };
}

function toolPart(tool: ToolItem): Part {
  const base = { toolCallId: tool.callId, toolName: tool.name, args: tool.input ?? {} };
  const toolInvocation =
    tool.status === 'running'
      ? { ...base, state: 'call' }
      : // fork(claude-agent): a stop the person asked for is not a failure.
        tool.stopped
        ? { ...base, state: 'result', result: 'Stopped' }
        : tool.denied
          ? { ...base, state: 'output-denied', errorText: tool.error ?? 'Denied' }
          : tool.status === 'error'
            ? { ...base, state: 'output-error', errorText: tool.error ?? 'Tool failed' }
            : { ...base, state: 'result', result: tool.result };
  return { type: 'tool-invocation', toolInvocation } as unknown as Part;
}

function toolCall(tool: ToolItem): ToolCall {
  return {
    toolCallId: tool.callId,
    toolName: tool.name,
    argsText: tool.inputText,
    ...(tool.input !== undefined ? { args: tool.input } : {}),
    // fork(claude-agent): a stopped tool shows as stopped, not as a failure.
    ...(tool.stopped
      ? { status: 'done' as const, result: 'Stopped', stopped: true }
      : {
          status: tool.status,
          ...(tool.status === 'error'
            ? { result: tool.error }
            : tool.result !== undefined
              ? { result: tool.result }
              : {}),
        }),
    output: tool.stdout + tool.stderr,
    createdAt: Date.parse(tool.startedAt) || undefined,
    ...(tool.exit
      ? {
          exit: {
            exitCode: tool.exit.code,
            ...(tool.exit.killed ? { killed: true } : {}),
            ...(tool.exit.timedOut ? { timedOut: true } : {}),
            ...(tool.exit.error ? { error: tool.exit.error } : {}),
          },
        }
      : {}),
  };
}

/** Pending interactions become the prompt cards the renderers already draw; settled ones draw nothing. */
function promptEntry(item: InteractionItem, tool: ToolItem | undefined): PromptEntry | undefined {
  if (item.status !== 'pending') return undefined;
  const { interaction } = item;
  const toolCallId = interaction.callId ?? interaction.id;
  const request = interaction.request;
  switch (request.kind) {
    case 'tool_approval':
      return {
        kind: 'approval',
        id: `approval-${toolCallId}`,
        toolCallId,
        toolName: request.toolName,
        args: request.input,
      };
    case 'question':
      return {
        kind: 'suspension',
        id: `suspension-${toolCallId}`,
        toolCallId,
        toolName: tool?.name ?? 'ask_user',
        args: tool?.input ?? {},
        suspendPayload: {
          question: request.question,
          ...(request.options ? { options: request.options } : {}),
          ...(request.selection
            ? { selectionMode: request.selection === 'multiple' ? 'multi_select' : 'single_select' }
            : {}),
        },
      };
    case 'plan_approval':
      return {
        kind: 'suspension',
        id: `suspension-${toolCallId}`,
        toolCallId,
        toolName: tool?.name ?? 'submit_plan',
        args: tool?.input ?? { path: request.planPath },
        suspendPayload: { path: request.planPath, ...(request.plan ? { plan: request.plan } : {}) },
      };
    case 'tool_input':
      // Only the broker records these (a tool's own prompt is drawn from its tool call), never the log.
      return undefined;
  }
}

/** Notices are drawn by the signal rows, which read `content.metadata.signal`. */
function noticeEntry(item: NoticeItem): MessageEntry {
  const signal = {
    type: item.noticeKind,
    ...(item.tag ? { tagName: item.tag } : {}),
    contents: item.text,
    ...(item.attributes ? { attributes: item.attributes } : {}),
  };
  return {
    kind: 'message',
    id: item.noticeId,
    message: {
      id: item.noticeId,
      role: 'signal',
      createdAt: new Date(item.at),
      content: { format: 2, parts: [{ type: 'text', text: item.text }], metadata: { signal } },
    },
  };
}

function subagentEntry(item: SubagentItem): TimelineEntry {
  return {
    kind: 'subagent',
    id: `subagent-${item.callId}`,
    toolCallId: item.callId,
    agentType: item.agentType,
    task: item.task,
    modelId: item.modelId ?? '',
    done: item.status !== 'running',
  };
}
