// fork(claude-agent)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineFactoryTool } from '@factory/agent-runtime';
import type { FactoryToolContext, InteractionRequest, InteractionResponse } from '@factory/agent-runtime';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  INTERACTIVE_TOOLS,
  claudeAgentToolDefs,
  claudeInputSchema,
  runMastraTool,
  toolIdentity,
} from './claude-agent-tools.js';
import { claudeAgentRequestContext } from './claude-agent-workspace.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'claude-tools-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function turnContext(user?: Record<string, unknown>) {
  const host = new RequestContext();
  if (user) host.set('user', user);
  return claudeAgentRequestContext('session-1')(host);
}

function ctx(answer?: (request: InteractionRequest) => InteractionResponse) {
  const interact = vi.fn(async (request: InteractionRequest) => {
    if (!answer) throw new Error('nobody asked');
    return answer(request);
  });
  const context = {
    sessionId: 'session-1',
    callId: 'toolu_1',
    orgId: 'org-1',
    userId: 'user-1',
    workspace: {} as FactoryToolContext['workspace'],
    signal: new AbortController().signal,
    interact,
  } as unknown as FactoryToolContext;
  return { context, interact };
}

describe('runMastraTool', () => {
  it("runs a Factory tool as Mastra Code's agent would: the turn's caller and session, the call's id", async () => {
    const seen: unknown[] = [];
    const probe = createTool({
      id: 'factory_probe',
      description: 'Reads what a tool reads',
      inputSchema: z.object({ item: z.string() }),
      execute: async ({ item }, execution) => {
        const controller = execution.requestContext?.get('controller') as { sessionId: string; threadId: string };
        seen.push({
          item,
          sessionId: controller.sessionId,
          threadId: controller.threadId,
          user: execution.requestContext?.get('user'),
          toolCallId: execution.agent?.toolCallId,
        });
        return { ok: true };
      },
    });
    const requestContext = turnContext({ workosId: 'user-1', organizationId: 'org-1' });
    const { context } = ctx();
    expect(
      await runMastraTool('factory_probe', probe, { item: 'w1' }, context, {
        requestContext,
        cwd,
        sessionId: 'session-1',
      }),
    ).toEqual({
      ok: true,
    });
    expect(seen).toEqual([
      {
        item: 'w1',
        sessionId: 'session-1',
        threadId: 'session-1',
        user: { workosId: 'user-1', organizationId: 'org-1' },
        toolCallId: 'toolu_1',
      },
    ]);
    expect(toolIdentity(requestContext)).toEqual({ orgId: 'org-1', userId: 'user-1' });
    expect(toolIdentity(turnContext())).toEqual({ orgId: 'local', userId: 'local' });
  });

  // fork(claude-agent): live board run, source_control_push_branch failed with "The active Factory
  // workspace has no executable sandbox." because the call carried no workspace.
  it("gives a workspace-backed tool the session's workspace, as Mastra gives an agent's", async () => {
    const sandbox = { executeCommand: vi.fn() };
    const sessionWorkspace = { id: 'mfw-1', sandbox };
    let seen: unknown;
    const push = createTool({
      id: 'source_control_push_branch',
      description: 'd',
      inputSchema: z.object({}),
      execute: async (_input, execution) => {
        seen = (execution as { workspace?: unknown }).workspace;
        return { ok: true };
      },
    });
    await runMastraTool('source_control_push_branch', push, {}, ctx().context, {
      requestContext: turnContext(),
      cwd,
      sessionId: 'session-1',
      workspace: sessionWorkspace,
    });
    expect(seen).toBe(sessionWorkspace);
  });

  it('turns a rejected input into an error Claude sees', async () => {
    const strict = createTool({
      id: 'factory_strict',
      description: 'd',
      inputSchema: z.object({ n: z.number() }),
      execute: async () => ({ ok: true }),
    });
    await expect(
      runMastraTool('factory_strict', strict, { n: 'one' }, ctx().context, {
        requestContext: turnContext(),
        cwd,
        sessionId: 's',
      }),
    ).rejects.toThrow(/validation/i);
  });

  it('asks the question of ask_user through Factory and returns the answer', async () => {
    const { context, interact } = ctx(() => ({ kind: 'question', answer: ['Postgres', 'SQLite'] }));
    const answer = await runMastraTool(
      'ask_user',
      INTERACTIVE_TOOLS.ask_user!,
      {
        question: 'Which databases?',
        options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'local' }],
        selectionMode: 'multi_select',
      },
      context,
      { requestContext: turnContext(), cwd, sessionId: 's' },
    );
    expect(interact).toHaveBeenCalledWith({
      kind: 'question',
      question: 'Which databases?',
      options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'local' }],
      selection: 'multiple',
    });
    expect(answer).toBe('User answered: Postgres, SQLite');
  });

  it('submits the plan file from the checkout for approval and reports the decision', async () => {
    await mkdir(join(cwd, '.artifacts', 'plans'), { recursive: true });
    await writeFile(join(cwd, '.artifacts', 'plans', 'dark-mode.md'), '# Dark mode\n\n1. Tokens\n');
    const approve = ctx(() => ({ kind: 'plan_approval', action: 'approved' }));
    const approved = await runMastraTool(
      'submit_plan',
      INTERACTIVE_TOOLS.submit_plan!,
      { path: '.artifacts/plans/dark-mode.md' },
      approve.context,
      { requestContext: turnContext(), cwd, sessionId: 's' },
    );
    expect(approve.interact).toHaveBeenCalledWith({
      kind: 'plan_approval',
      planPath: '.artifacts/plans/dark-mode.md',
      plan: '# Dark mode\n\n1. Tokens\n',
    });
    expect(approved).toBe('Plan approved. Proceed with implementation following the approved plan.');

    const reject = ctx(() => ({ kind: 'plan_approval', action: 'rejected', feedback: 'Cover high contrast' }));
    const rejected = await runMastraTool(
      'submit_plan',
      INTERACTIVE_TOOLS.submit_plan!,
      { path: '.artifacts/plans/dark-mode.md' },
      reject.context,
      { requestContext: turnContext(), cwd, sessionId: 's' },
    );
    expect(rejected).toContain('User feedback: Cover high contrast');
  });

  it('never reads a plan from outside the checkout', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'claude-tools-outside-'));
    try {
      await writeFile(join(outside, 'secret.md'), 'secret');
      const { context, interact } = ctx(() => ({ kind: 'plan_approval', action: 'approved' }));
      await runMastraTool(
        'submit_plan',
        INTERACTIVE_TOOLS.submit_plan!,
        { path: join(outside, 'secret.md') },
        context,
        {
          requestContext: turnContext(),
          cwd,
          sessionId: 's',
        },
      );
      expect(interact).toHaveBeenCalledWith({ kind: 'plan_approval', planPath: join(outside, 'secret.md') });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('claudeAgentToolDefs', () => {
  it("offers each tool with its own schema, rebuilding one from JSON Schema when it isn't Zod", async () => {
    const zodTool = createTool({
      id: 'factory_list_work_items',
      description: 'List work items',
      inputSchema: z.object({ stage: z.string().optional() }),
      execute: async () => [],
    });
    const jsonTool = createTool({
      id: 'github_get_issue',
      description: 'Get an issue',
      inputSchema: {
        type: 'object',
        properties: { number: { type: 'integer' } },
        required: ['number'],
      } as never,
      execute: async () => ({}),
    });
    const run = vi.fn(async () => 'ran');
    const defs = claudeAgentToolDefs({ factory_list_work_items: zodTool, github_get_issue: jsonTool }, run);
    expect(defs.map(def => [def.name, def.description])).toEqual([
      ['factory_list_work_items', 'List work items'],
      ['github_get_issue', 'Get an issue'],
    ]);
    expect(defs[0]!.input).toBe(zodTool.inputSchema);
    expect(defs[1]!.input.safeParse({ number: 7 }).success).toBe(true);
    expect(defs[1]!.input.safeParse({}).success).toBe(false);
    expect(claudeInputSchema(createTool({ id: 'x', description: 'x', execute: async () => 1 }))).toBeDefined();

    await defs[0]!.execute({}, ctx().context);
    expect(run).toHaveBeenCalledWith('factory_list_work_items', {}, expect.objectContaining({ callId: 'toolu_1' }));
  });

  // fork(claude-agent): slice 4.
  it('offers a Factory tool definition as it is, its calls still going through the turn', async () => {
    const def = defineFactoryTool({
      name: 'factory_list_attention',
      description: 'What needs a person',
      input: z.object({ limit: z.number().int().optional() }).strict(),
      approval: 'none',
      execute: async () => 'not called directly',
    });
    const run = vi.fn(async () => 'ran');
    const [listed] = claudeAgentToolDefs({ factory_list_attention: def, missing: undefined }, run);
    expect(listed).toMatchObject({
      name: 'factory_list_attention',
      description: 'What needs a person',
      approval: 'none',
    });
    expect(listed!.input).toBe(def.input);
    expect(await listed!.execute({ limit: 1 }, ctx().context)).toBe('ran');
    expect(run).toHaveBeenCalledWith(
      'factory_list_attention',
      { limit: 1 },
      expect.objectContaining({ callId: 'toolu_1' }),
    );
  });
});
