// fork(claude-agent): write commands on Factory's runtime-neutral session API.
import type { AgentControllerCommandAck, AgentControllerThinkingLevel, PlanResume } from '@mastra/client-js';

const sessionPath = (baseUrl: string, sessionId: string) =>
  `${baseUrl}/web/factory/sessions/${encodeURIComponent(sessionId)}`;

/**
 * Same acknowledgement shape as the agent-controller client: a refused reply resolves with
 * `ok: false` and the runtime's own reason (e.g. `no_pending_suspension`), anything else throws.
 */
async function command(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<AgentControllerCommandAck> {
  const response = await fetch(url, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    reason?: string;
    message?: string;
    error?: string;
  };
  if (response.ok) return { ok: true };
  if (response.status === 409) {
    return { ok: false, reason: payload.message ?? payload.reason } as AgentControllerCommandAck;
  }
  throw new Error(payload.error ?? payload.message ?? `Session command failed (${response.status})`);
}

/** Send, abort and model switch resolve with nothing and throw on any refusal, like the agent-controller client. */
async function voidCommand(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<void> {
  const ack = await command(url, method, body);
  if (!ack.ok) throw new Error(`Session command was refused (${ack.reason ?? 'unknown'})`);
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
  return command(`${sessionPath(baseUrl, sessionId)}/interactions`, 'POST', {
    callId: toolCallId,
    response: { kind: 'tool_approval', approved },
  });
}

export function respondToFactorySessionPrompt(
  baseUrl: string,
  sessionId: string,
  toolCallId: string,
  resumeData: string | string[] | PlanResume,
) {
  const response =
    typeof resumeData === 'string' || Array.isArray(resumeData)
      ? { kind: 'question', answer: resumeData }
      : {
          kind: 'plan_approval',
          action: resumeData.action,
          ...(resumeData.feedback ? { feedback: resumeData.feedback } : {}),
          ...(resumeData.path || resumeData.title || resumeData.plan
            ? {
                plan: {
                  ...(resumeData.path ? { path: resumeData.path } : {}),
                  ...(resumeData.title ? { title: resumeData.title } : {}),
                  ...(typeof resumeData.plan === 'string' ? { content: resumeData.plan } : {}),
                },
              }
            : {}),
        };
  return command(`${sessionPath(baseUrl, sessionId)}/interactions`, 'POST', { callId: toolCallId, response });
}

export function switchFactorySessionModel(
  baseUrl: string,
  sessionId: string,
  modelId: string,
  thinkingLevel?: AgentControllerThinkingLevel,
) {
  return voidCommand(`${sessionPath(baseUrl, sessionId)}/model`, 'PUT', {
    modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
}
