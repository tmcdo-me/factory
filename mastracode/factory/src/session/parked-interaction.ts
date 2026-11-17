// fork(claude-agent): what a parked session waits on, in the seam's runtime-neutral shape, so it can be answered from outside the session.
import type { InteractionRecord, InteractionRequest } from '@factory/agent-runtime';

/** The call a parked session waits on, and what a person needs to answer it. */
export interface ParkedInteraction {
  /**
   * The tool call that asked; an answer from outside the session names it. Absent for a question a
   * Claude Agent turn ended on in plain text, which only the interaction id names.
   */
  toolCallId?: string;
  /** The interaction broker's id for it (Claude Agent sessions only: Mastra Code's calls are named by their tool call). */
  interactionId?: string;
  request: InteractionRequest;
}

/**
 * What a pending interaction asks, when a person can answer it from outside the session. A question
 * a Claude Agent run's turn ended on in plain text was asked by no tool call: only its interaction id
 * names it. A call a runtime holds (Mastra Code's) is named by its tool call, as before; a tool that
 * resumes on input of its own is answered only in its session.
 */
export function brokerInteraction(record: InteractionRecord): ParkedInteraction | undefined {
  const { request } = record;
  if (request.kind === 'tool_input') return undefined;
  if (!record.callId && request.kind !== 'question') return undefined;
  if (record.heldBy && record.callId) return { toolCallId: record.callId, request };
  return { ...(record.callId ? { toolCallId: record.callId } : {}), interactionId: record.id, request };
}

/** The Factory tool that answers it from another session. */
export function answeringTool(interaction: ParkedInteraction): 'factory_answer_question' | 'factory_answer_approval' {
  return interaction.request.kind === 'question' ? 'factory_answer_question' : 'factory_answer_approval';
}

/**
 * The answer a question takes from outside its session, checked against what it asks: one value
 * for a question with no options or a single choice, one or more distinct values for a multiple
 * choice. As in the session, where every question with options also offers "Other…", a value
 * needn't be one of the labels; a multiple choice takes at most one value of the person's own.
 * Throws a message for the person when the answer doesn't fit.
 */
export function checkedAnswer(request: InteractionRequest, answer: string | string[]): string | string[] {
  if (request.kind !== 'question') throw new Error('This call waits for a yes or no, not an answer.');
  const values = (Array.isArray(answer) ? answer : [answer]).map(value => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error('Give an answer.');
  const options = request.options ?? [];
  if (options.length === 0 || request.selection !== 'multiple') {
    if (values.length > 1) {
      throw new Error(
        options.length === 0 ? 'This question takes one answer in words.' : 'This question takes one choice.',
      );
    }
    return values[0]!;
  }
  if (new Set(values).size !== values.length) throw new Error('Pick each option once.');
  const labels = new Set(options.map(option => option.label));
  if (values.filter(value => !labels.has(value)).length > 1) {
    throw new Error(
      `Pick from the options (${options.map(option => option.label).join(', ')}), with at most one answer of your own.`,
    );
  }
  return values;
}
