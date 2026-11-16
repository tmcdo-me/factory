// fork(claude-agent): Factory's session tools, as Mastra Code gets them, adapted for Claude Agent.
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type {
  FactoryToolContext,
  FactoryToolDef,
  InteractionRequest,
  InteractionResponse,
  SandboxProcess,
  SessionWorkspace,
} from '@factory/agent-runtime';
import type { RequestContext } from '@mastra/core/request-context';
import { askUserTool, submitPlanTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';
import type { MastraSandbox } from '@mastra/core/workspace';
import { z } from 'zod';
import type { ZodType } from 'zod';

import { factoryUserOrgId, getFactoryAuthUserFromContext, getFactoryAuthUserId } from '../auth.js';

// oxlint-disable-next-line typescript/no-explicit-any -- Factory's tools have every input and output shape.
export type MastraTool = Tool<any, any, any, any>;
export type MastraTools = Record<string, MastraTool>;

/**
 * The human-in-the-loop tools Mastra Code builds in. Claude Agent sessions get the same definitions;
 * their suspension becomes a Factory interaction (see `runMastraTool`).
 */
export const INTERACTIVE_TOOLS: MastraTools = { ask_user: askUserTool, submit_plan: submitPlanTool };

/** Plans larger than this are shown truncated in the approval card; the file itself is untouched. */
const MAX_PLAN_BYTES = 256 * 1024;

/**
 * A tool's input schema for Claude: the tool's own Zod schema, else one rebuilt from the JSON Schema
 * it publishes. `undefined` when neither works; the tool is then not offered.
 */
export function claudeInputSchema(tool: MastraTool): ZodType | undefined {
  const schema = tool.inputSchema as unknown;
  if (!schema) return z.looseObject({});
  if (typeof schema === 'object' && '_zod' in schema) return schema as ZodType;
  try {
    const standard = (schema as { '~standard'?: { jsonSchema?: { input(options: { target: string }): unknown } } })[
      '~standard'
    ];
    const json = standard?.jsonSchema?.input({ target: 'draft-07' });
    return json ? (z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]) as ZodType) : undefined;
  } catch {
    return undefined;
  }
}

export interface ClaudeAgentToolCallContext {
  /** The request context of the turn making the call (`claudeAgentRequestContext`). */
  requestContext: RequestContext;
  /** The session's checkout, where `submit_plan` reads plans from. */
  cwd: string;
  sessionId: string;
  /**
   * The session's Factory workspace, given to the tool as Mastra gives an agent's workspace: tools
   * such as `source_control_push_branch` run git in its sandbox and fail without it.
   */
  workspace?: unknown;
}

/**
 * Run a Mastra tool for a Claude Agent call, the way Mastra Code's agent would: with the turn's
 * request context, the call's id and abort signal. A tool that suspends to ask the human (`ask_user`,
 * `submit_plan`) asks through `ctx.interact` instead and runs again with the answer, as Mastra
 * Code's resume does.
 */
export async function runMastraTool(
  name: string,
  tool: MastraTool,
  input: unknown,
  ctx: FactoryToolContext,
  call: ClaudeAgentToolCallContext,
): Promise<unknown> {
  if (!tool.execute) throw new Error(`Factory tool ${name} cannot run here`);
  let suspended: { payload: unknown } | undefined;
  const agent = {
    agentId: 'claude-agent',
    toolCallId: ctx.callId,
    messages: [],
    threadId: call.sessionId,
    resourceId: call.sessionId,
    suspend: async (payload: unknown) => {
      suspended = { payload };
    },
  };
  const execution = {
    requestContext: call.requestContext,
    abortSignal: ctx.signal,
    agent,
    ...(call.workspace ? { workspace: call.workspace } : {}),
  };
  let output: unknown = await tool.execute(input, execution as never);
  if (suspended) {
    const { request, resume } = await interactionFor(name, suspended.payload, call.cwd);
    const response = await ctx.interact(request);
    output = await tool.execute(input, {
      ...execution,
      agent: { ...agent, suspendPayload: suspended.payload, resumeData: resume(response) },
    } as never);
  }
  return toolOutput(output);
}

/**
 * The answer a suspended tool waits for, and how the answer resumes it. Only questions and plan
 * approvals have a human on the other end in Claude Agent sessions.
 */
async function interactionFor(
  name: string,
  payload: unknown,
  cwd: string,
): Promise<{ request: InteractionRequest; resume(response: InteractionResponse): unknown }> {
  const data = (payload ?? {}) as Record<string, unknown>;
  if (name === 'submit_plan' || data.toolId === 'submit_plan') {
    const planPath = typeof data.path === 'string' ? data.path : '';
    const plan = await readPlan(cwd, planPath);
    const title = plan?.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return {
      request: { kind: 'plan_approval', planPath, ...(plan !== undefined ? { plan } : {}) },
      resume: response => {
        const answer = response as Extract<InteractionResponse, { kind: 'plan_approval' }>;
        return {
          action: answer.action,
          ...(answer.feedback ? { feedback: answer.feedback } : {}),
          path: answer.plan?.path ?? planPath,
          ...((answer.plan?.title ?? title) ? { title: answer.plan?.title ?? title } : {}),
          ...((answer.plan?.content ?? plan) !== undefined ? { plan: answer.plan?.content ?? plan } : {}),
        };
      },
    };
  }
  if (typeof data.question === 'string') {
    const options = Array.isArray(data.options)
      ? (data.options as { label: string; description?: string }[]).map(option => ({
          label: String(option.label),
          ...(option.description ? { description: String(option.description) } : {}),
        }))
      : undefined;
    return {
      request: {
        kind: 'question',
        question: data.question,
        ...(options?.length ? { options } : {}),
        ...(data.selectionMode === 'multi_select' ? { selection: 'multiple' as const } : {}),
        ...(data.selectionMode === 'single_select' ? { selection: 'single' as const } : {}),
      },
      resume: response => (response as Extract<InteractionResponse, { kind: 'question' }>).answer,
    };
  }
  throw new Error(`Factory tool ${name} waits for an answer Claude Agent sessions cannot ask for yet`);
}

/** The plan file, read from inside the checkout only; `undefined` when it is missing or outside. */
async function readPlan(cwd: string, planPath: string): Promise<string | undefined> {
  if (!planPath) return undefined;
  try {
    const root = await realpath(cwd);
    const file = await realpath(resolve(root, planPath));
    const inside = relative(root, file);
    if (inside.startsWith('..') || isAbsolute(inside)) return undefined;
    const content = await readFile(file);
    return content.subarray(0, MAX_PLAN_BYTES).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * What a tool's output tells Claude. Mastra reports a rejected input as a returned validation error
 * and its built-ins answer `{ content, isError }`; both become plain text or a tool error.
 */
function toolOutput(output: unknown): unknown {
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (record.error === true && typeof record.message === 'string') throw new Error(record.message);
    if (typeof record.content === 'string' && typeof record.isError === 'boolean') {
      if (record.isError) throw new Error(record.content);
      return record.content;
    }
  }
  return output;
}

/**
 * Factory tool definitions for a Claude Agent session. The list (names, descriptions, schemas) is
 * fixed when Claude Code starts; each call runs the tool as built for the call's own turn
 * (`toolsFor`), as Mastra Code rebuilds its tools every turn. A tool the turn no longer has fails.
 */
export function claudeAgentToolDefs(
  listed: MastraTools,
  run: (name: string, input: unknown, ctx: FactoryToolContext) => Promise<unknown>,
): FactoryToolDef[] {
  const defs: FactoryToolDef[] = [];
  for (const [name, tool] of Object.entries(listed)) {
    const input = claudeInputSchema(tool);
    if (!input || !tool.execute) {
      console.warn(`[factory] Claude Agent sessions do not get Factory tool '${name}': its input schema is unusable`);
      continue;
    }
    defs.push({ name, description: tool.description ?? name, input, execute: (args, ctx) => run(name, args, ctx) });
  }
  return defs;
}

/** Who a turn's tool calls act as: the signed-in caller, or the shared `local` tenant without auth. */
export function toolIdentity(requestContext: RequestContext): { orgId: string; userId: string } {
  const user = getFactoryAuthUserFromContext(requestContext);
  return { orgId: factoryUserOrgId(user) ?? 'local', userId: getFactoryAuthUserId(user) ?? 'local' };
}

/** The seam's view of a local session checkout. */
export function localSessionWorkspace(options: {
  cwd: string;
  env: Record<string, string>;
  sandbox?: unknown;
}): SessionWorkspace {
  return {
    kind: 'local',
    checkoutDir: options.cwd,
    sandbox: options.sandbox as MastraSandbox,
    env: async () => ({ ...options.env }),
    spawn: (command, args, spawnOptions) =>
      spawn(command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: 'pipe',
        ...(spawnOptions.signal ? { signal: spawnOptions.signal } : {}),
      }) as unknown as SandboxProcess,
  };
}
