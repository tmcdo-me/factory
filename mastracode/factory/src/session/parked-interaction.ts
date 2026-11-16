// fork(claude-agent): what a parked session waits on, in the seam's runtime-neutral shape, so it can be answered from outside the session.
import type { InteractionRecord, InteractionRequest } from '@factory/agent-runtime';

import { resumesOnDecision } from '../tools/run-watch.js';

/** The call a parked session waits on, and what a person needs to answer it. */
export interface ParkedInteraction {
  /**
   * The tool call that asked; an answer from outside the session names it. Absent for a question a
   * Claude Agent turn ended on in plain text, which only the interaction id names.
   */
  toolCallId?: string;
  /** The interaction broker's id for it (Claude Agent sessions only). */
  interactionId?: string;
  request: InteractionRequest;
}

/** A Mastra Code session's paused tool, as the agent controller's display state holds it. */
export interface PausedToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  suspendPayload?: unknown;
  resumeSchema?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function questionOptions(value: unknown): { label: string; description?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap(option => {
    const { label, description } = record(option);
    if (typeof label !== 'string' || !label) return [];
    return [{ label, ...(typeof description === 'string' && description ? { description } : {}) }];
  });
  return options.length > 0 ? options : undefined;
}

/**
 * What a paused Mastra Code tool asks, or nothing when it is not something a person can answer
 * from outside the session: a question (`ask_user`: its payload carries the question), a plan
 * (`submit_plan`), or another tool that resumes on a bare yes or no.
 */
export function pausedToolInteraction(call: PausedToolCall): ParkedInteraction | undefined {
  const payload = record(call.suspendPayload);
  if (typeof payload.question === 'string' && payload.question && !resumesOnDecision(call.resumeSchema)) {
    const options = questionOptions(payload.options);
    return {
      toolCallId: call.toolCallId,
      request: {
        kind: 'question',
        question: payload.question,
        ...(options ? { options } : {}),
        ...(options
          ? { selection: payload.selectionMode === 'multi_select' ? ('multiple' as const) : ('single' as const) }
          : {}),
      },
    };
  }
  if (!resumesOnDecision(call.resumeSchema)) return undefined;
  if (call.toolName === 'submit_plan' || payload.toolId === 'submit_plan') {
    const planPath = typeof payload.path === 'string' ? payload.path : '';
    return {
      toolCallId: call.toolCallId,
      request: {
        kind: 'plan_approval',
        planPath,
        ...(typeof payload.plan === 'string' && payload.plan ? { plan: payload.plan } : {}),
      },
    };
  }
  return {
    toolCallId: call.toolCallId,
    request: { kind: 'tool_approval', toolName: call.toolName, input: call.args ?? null },
  };
}

/**
 * What a Claude Agent session's pending interaction asks. A question the run's turn ended on in
 * plain text was asked by no tool call: only its interaction id names it.
 */
export function brokerInteraction(record: InteractionRecord): ParkedInteraction | undefined {
  if (!record.callId && record.request.kind !== 'question') return undefined;
  return { ...(record.callId ? { toolCallId: record.callId } : {}), interactionId: record.id, request: record.request };
}

/** The Factory tool that answers it from another session. */
export function answeringTool(interaction: ParkedInteraction): 'factory_answer_question' | 'factory_answer_approval' {
  return interaction.request.kind === 'question' ? 'factory_answer_question' : 'factory_answer_approval';
}
