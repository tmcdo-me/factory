import type { CommandFailure, CommandRequest, CommandResult, SessionCommands } from '@factory/agent-runtime';
import type { Mastra } from '@mastra/core/mastra';
import {
  ABORT_AGENT_CONTROLLER_SESSION_ROUTE,
  AGENT_CONTROLLER_TOOL_APPROVAL_ROUTE,
  AGENT_CONTROLLER_TOOL_SUSPENSION_ROUTE,
  SEND_AGENT_CONTROLLER_MESSAGE_ROUTE,
  SWITCH_AGENT_CONTROLLER_MODEL_ROUTE,
} from '@mastra/server/handlers/agent-controller';

import { mastraCodeResumeData } from './answers';

/**
 * Session commands for Mastra Code sessions, carried out by Mastra's own agent-controller route
 * handlers called in-process. Factory's session API gets exactly the behaviour of the
 * agent-controller HTTP routes (session recovery, duplicate-answer claims, persisted approvals,
 * background acks) without a copy of that logic.
 */
export function createMastraCodeSessionCommands(options: {
  /** Resolved per call: the Mastra instance is built after Factory's routes. */
  mastra: () => Mastra | undefined;
  controllerId: string;
}): SessionCommands {
  const call = async (
    route: { handler?: unknown },
    sessionId: string,
    request: CommandRequest,
    params: Record<string, unknown>,
  ): Promise<CommandResult> => {
    const mastra = options.mastra();
    if (!mastra) return { ok: false, reason: 'session_not_found', message: 'Factory has not started yet' };
    const handler = route.handler as (args: Record<string, unknown>) => Promise<unknown>;
    try {
      const result = await handler({
        ...params,
        mastra,
        controllerId: options.controllerId,
        sessionId,
        requestContext: request.context,
      });
      return toResult(result);
    } catch (error) {
      if (statusOf(error) === 404) {
        return { ok: false, reason: 'session_not_found', message: error instanceof Error ? error.message : undefined };
      }
      throw error;
    }
  };

  return {
    send: (sessionId, input, request) =>
      call(SEND_AGENT_CONTROLLER_MESSAGE_ROUTE, sessionId, request, {
        message: input.text,
        ...(input.files?.length ? { files: input.files } : {}),
      }),

    abort: (sessionId, request) => call(ABORT_AGENT_CONTROLLER_SESSION_ROUTE, sessionId, request, {}),

    answer: async (sessionId, target, response, request) => {
      const toolCallId = target.callId ?? callIdOf(target.interactionId);
      if (!toolCallId)
        return { ok: false, reason: 'invalid', message: 'Name the interaction or the tool call it waits on' };
      if (response.kind === 'tool_approval') {
        return call(AGENT_CONTROLLER_TOOL_APPROVAL_ROUTE, sessionId, request, {
          toolCallId,
          approved: response.approved,
        });
      }
      return call(AGENT_CONTROLLER_TOOL_SUSPENSION_ROUTE, sessionId, request, {
        toolCallId,
        resumeData: mastraCodeResumeData(response),
      });
    },

    setModel: (sessionId, model, request) =>
      call(SWITCH_AGENT_CONTROLLER_MODEL_ROUTE, sessionId, request, {
        modelId: model.modelId,
        ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
      }),
  };
}

/** Interaction ids from `MastraCodeEventMapper` are `<kind>:<toolCallId>`. */
function callIdOf(interactionId: string | undefined): string | undefined {
  if (!interactionId) return undefined;
  const separator = interactionId.indexOf(':');
  return separator >= 0 ? interactionId.slice(separator + 1) || undefined : undefined;
}

function toResult(result: unknown): CommandResult {
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    const reason = (result as { reason?: unknown }).reason;
    const failure: CommandFailure =
      reason === 'not_pending' || reason === 'stale_tool_call' || reason === 'no_pending_suspension'
        ? 'not_pending'
        : 'invalid';
    return { ok: false, reason: failure, ...(typeof reason === 'string' ? { message: reason } : {}) };
  }
  return { ok: true };
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
