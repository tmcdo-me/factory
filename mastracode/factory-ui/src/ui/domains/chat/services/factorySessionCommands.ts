// fork(claude-agent): write commands on Factory's runtime-neutral session API, for every runtime.
import type { InteractionResponse, ThinkingLevel } from '@factory/agent-runtime/browser';

const sessionPath = (baseUrl: string, sessionId: string) =>
  `${baseUrl}/web/factory/sessions/${encodeURIComponent(sessionId)}`;

/** A reply to a plan approval card: what the person decided, and the plan as they saw it. */
export interface PlanResume {
  action: 'approved' | 'rejected';
  feedback?: string;
  path?: string;
  title?: string;
  plan?: string;
}

/** A reply to a suspended tool: an `ask_user` answer, or a plan decision. */
export type PromptReply = string | string[] | PlanResume;

/** A reply the session refused: `reason` is the runtime's own (e.g. `no_pending_suspension`). */
export type CommandAck = { ok: true } | { ok: false; reason?: string };

/** A command the server answered with an error status; a 4xx means it refused the command. */
export class SessionCommandError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SessionCommandError';
    this.status = status;
  }
}

interface CommandPayload {
  ok?: boolean;
  reason?: string;
  message?: string;
  error?: string;
}

async function request(url: string, method: 'POST' | 'PUT', body?: unknown) {
  const response = await fetch(url, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as CommandPayload;
  return { response, payload };
}

function failure(response: Response, payload: CommandPayload): SessionCommandError {
  return new SessionCommandError(
    payload.error ?? payload.message ?? payload.reason ?? `Session command failed (${response.status})`,
    response.status,
  );
}

/** A reply: refused (409) resolves with `ok: false` and the runtime's reason; any other failure throws. */
async function reply(url: string, body: unknown): Promise<CommandAck> {
  const { response, payload } = await request(url, 'POST', body);
  if (response.ok) return { ok: true };
  if (response.status === 409) return { ok: false, reason: payload.message ?? payload.reason };
  throw failure(response, payload);
}

/** Send, abort and model switch resolve with nothing and throw on any failure. */
async function voidCommand(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<void> {
  const { response, payload } = await request(url, method, body);
  if (!response.ok) throw failure(response, payload);
}

export function sendFactorySessionMessage(
  baseUrl: string,
  sessionId: string,
  input: { text: string; files?: Array<{ data: string; mediaType: string; filename?: string }> },
) {
  return voidCommand(`${sessionPath(baseUrl, sessionId)}/messages`, 'POST', {
    text: input.text,
    ...(input.files?.length ? { files: input.files } : {}),
  });
}

export function abortFactorySession(baseUrl: string, sessionId: string) {
  return voidCommand(`${sessionPath(baseUrl, sessionId)}/abort`, 'POST');
}

export function approveFactorySessionTool(baseUrl: string, sessionId: string, toolCallId: string, approved: boolean) {
  const response: InteractionResponse = { kind: 'tool_approval', approved };
  return reply(`${sessionPath(baseUrl, sessionId)}/interactions`, { callId: toolCallId, response });
}

function interactionResponse(answer: PromptReply): InteractionResponse {
  if (typeof answer === 'string' || Array.isArray(answer)) return { kind: 'question', answer };
  return {
    kind: 'plan_approval',
    action: answer.action,
    ...(answer.feedback ? { feedback: answer.feedback } : {}),
    ...(answer.path || answer.title || answer.plan
      ? {
          plan: {
            ...(answer.path ? { path: answer.path } : {}),
            ...(answer.title ? { title: answer.title } : {}),
            ...(typeof answer.plan === 'string' ? { content: answer.plan } : {}),
          },
        }
      : {}),
  };
}

export function respondToFactorySessionPrompt(
  baseUrl: string,
  sessionId: string,
  toolCallId: string,
  answer: PromptReply,
) {
  return reply(`${sessionPath(baseUrl, sessionId)}/interactions`, {
    callId: toolCallId,
    response: interactionResponse(answer),
  });
}

export function switchFactorySessionModel(
  baseUrl: string,
  sessionId: string,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
) {
  return voidCommand(`${sessionPath(baseUrl, sessionId)}/model`, 'PUT', {
    modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
}
