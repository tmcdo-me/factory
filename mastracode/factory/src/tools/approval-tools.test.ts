// fork(claude-agent): also factory_answer_question's checks.
import { describe, expect, it, vi } from 'vitest';

import {
  QUESTION_ANSWERERS,
  answerParkedCall,
  createFactoryApprovalTools as createFactoryApprovalToolsDefs,
} from './approval-tools.js';
import type { FactoryToolScope } from './scope.js';
import { mastraSessionTools, scopeToolContext } from './toolset.js'; // fork(claude-agent)

// fork(claude-agent): the definitions as Mastra Code's agent gets them (slice 4).
const createFactoryApprovalTools = (...args: Parameters<typeof createFactoryApprovalToolsDefs>) =>
  mastraSessionTools(createFactoryApprovalToolsDefs(...args), scopeToolContext(args[0]));

const WORKER = '00000000-0000-4000-8000-000000000001';
const ITEM = 'item-1';

/** How each paused tool says what it resumes on, as the session reports it. */
const RESUME_SCHEMAS: Record<string, string> = {
  submit_plan: JSON.stringify({
    type: 'object',
    properties: { action: { type: 'string', enum: ['approved', 'rejected'] }, feedback: { type: 'string' } },
    required: ['action'],
  }),
  sign_off: JSON.stringify({
    type: 'object',
    properties: { action: { type: 'string', enum: ['approved', 'rejected'] } },
    required: ['action'],
  }),
  // Asks for a decision and a ticket number: a bare yes or no cannot finish this call.
  sign_off_with_ticket: JSON.stringify({
    type: 'object',
    properties: { action: { type: 'string', enum: ['approved', 'rejected'] }, ticket: { type: 'string' } },
    required: ['action', 'ticket'],
  }),
  ask_user: JSON.stringify({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }),
};

const scope: FactoryToolScope = {
  orgId: 'org-1',
  factoryProjectId: 'project-1',
  userId: 'user-1',
  sessionId: 'origin-session',
  resourceId: 'origin-session',
  threadId: 'origin-thread',
  kind: 'user',
  interactive: true,
  actorProfile: { name: 'Ada' },
};

function setup({
  row = {},
  binding = true,
  follows = true,
  armed = true,
  live = true,
  parkedTool,
  filedBy = 'someone-else',
  as = {},
}: {
  row?: Record<string, unknown>;
  binding?: boolean;
  follows?: boolean;
  armed?: boolean;
  live?: boolean;
  parkedTool?: string;
  /** fork(claude-agent): who filed the card. */
  filedBy?: string;
  /** fork(claude-agent): the calling turn, where it differs from `scope`. */
  as?: Partial<FactoryToolScope>;
} = {}) {
  const respondToToolApproval = vi.fn((_input: unknown) => ({ accepted: true as const }));
  // As the live session does: a paused call is answered by whoever claims it first, and stays
  // waiting when its resume fails to start.
  const address = { resourceId: 'resource-1', threadId: 'thread-1', runId: 'run-1', toolCallId: 'call-1' };
  const paused = { waiting: parkedTool !== undefined, claimed: false };
  const respondToToolSuspension = vi.fn(async (_input: unknown) => {
    paused.waiting = false;
  });
  const session = {
    suspensions: { has: () => paused.waiting },
    claimToolSuspension: () => {
      if (!paused.waiting) return { accepted: false as const, reason: 'no_pending_suspension' };
      if (paused.claimed) return { accepted: false as const, reason: 'not_pending' };
      paused.claimed = true;
      return { accepted: true as const, address, claimKey: 'claim-1' };
    },
    releaseToolResponse: () => {
      paused.claimed = false;
    },
    approval: { list: () => (armed ? [{ toolCallId: 'call-1', toolName: 'factory_transition_work_item' }] : []) },
    respondToToolApproval,
    displayState: {
      get: () => ({
        pendingSuspensions: new Map(
          parkedTool
            ? [
                [
                  'run-address',
                  {
                    toolCallId: 'call-1',
                    toolName: parkedTool,
                    resumeSchema: RESUME_SCHEMAS[parkedTool],
                    ...(parkedTool === 'ask_user'
                      ? {
                          suspendPayload: {
                            question: 'Which branch?',
                            options: [{ label: 'main' }, { label: 'release' }],
                            selectionMode: 'single_select',
                          },
                        }
                      : {}),
                  },
                ],
              ]
            : [],
        ),
      }),
    },
    respondToToolSuspension,
  };
  const record = vi.fn();
  const tools = createFactoryApprovalTools(
    { ...scope, ...as },
    {
      sessions: {
        getBySessionId: async () =>
          ({
            sessionId: WORKER,
            orgId: 'org-1',
            factoryProjectId: 'project-1',
            userId: 'someone-else',
            visibility: 'org',
            originSessionId: null,
            ...row,
          }) as never,
      },
      workItems: {
        findActiveRunBindingForSession: async () => (binding ? ({ workItemId: ITEM } as never) : null),
        listSessionSubscriptions: async () => (follows ? [{ workItemId: ITEM }] : []) as never,
        getForProject: async () => ({ id: ITEM, createdBy: filedBy }) as never,
      },
      auditRecorder: { record } as never,
      messaging: async () => ({ controller: { getSession: async () => (live ? session : null) } }) as never,
    },
  );
  const answer = (input: Record<string, unknown>) =>
    (
      tools.factory_answer_approval as unknown as { execute: (input: unknown, context: unknown) => Promise<unknown> }
    ).execute({ sessionId: WORKER, toolCallId: 'call-1', ...input }, {});
  const answerQuestion = (input: Record<string, unknown>) =>
    (
      tools.factory_answer_question as unknown as { execute: (input: unknown, context: unknown) => Promise<unknown> }
    ).execute({ sessionId: WORKER, toolCallId: 'call-1', ...input }, {});
  return { answer, answerQuestion, session, respondToToolApproval, respondToToolSuspension, record };
}

describe('factory_answer_approval', () => {
  it("approves a plan the session is parked on with submit_plan, resuming as the session's owner", async () => {
    const { answer, respondToToolApproval, respondToToolSuspension, record } = setup({
      armed: false,
      parkedTool: 'submit_plan',
    });

    await expect(answer({ decision: 'approve' })).resolves.toMatchObject({ answered: 'approve' });

    expect(respondToToolApproval).not.toHaveBeenCalled();
    expect(respondToToolSuspension).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeData: { action: 'approved' },
        address: expect.objectContaining({ toolCallId: 'call-1' }),
      }),
    );
    const { requestContext } = respondToToolSuspension.mock.calls[0]![0] as {
      requestContext: { get(key: string): unknown };
    };
    expect(requestContext.get('user')).toEqual({ workosId: 'someone-else', organizationId: 'org-1' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'factory.run.approved' }));
  });

  it('declines a parked plan with the reason as feedback', async () => {
    const { answer, respondToToolSuspension } = setup({ armed: false, parkedTool: 'submit_plan' });

    await answer({ decision: 'decline', reason: 'Split it in two.' });

    expect(respondToToolSuspension).toHaveBeenCalledWith(
      expect.objectContaining({ resumeData: { action: 'rejected', feedback: 'Split it in two.' } }),
    );
  });

  it('approves any tool that paused itself for a yes or no, not only a plan', async () => {
    const { answer, respondToToolApproval, respondToToolSuspension } = setup({ armed: false, parkedTool: 'sign_off' });

    await expect(answer({ decision: 'approve' })).resolves.toMatchObject({ answered: 'approve' });

    expect(respondToToolApproval).not.toHaveBeenCalled();
    expect(respondToToolSuspension).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeData: { action: 'approved' },
        address: expect.objectContaining({ toolCallId: 'call-1' }),
      }),
    );
  });

  it('does not approve a tool that needs more than a yes or no to carry on', async () => {
    const { answer, respondToToolApproval, respondToToolSuspension } = setup({
      armed: false,
      parkedTool: 'sign_off_with_ticket',
    });

    await expect(answer({ decision: 'approve' })).rejects.toThrow('Nothing is waiting on that tool call');

    expect(respondToToolApproval).not.toHaveBeenCalled();
    expect(respondToToolSuspension).not.toHaveBeenCalled();
  });

  it('does not answer a tool waiting on a typed answer, like ask_user', async () => {
    const { answer, respondToToolSuspension } = setup({ armed: false, parkedTool: 'ask_user' });

    await expect(answer({ decision: 'approve' })).rejects.toThrow(/Nothing is waiting/);
    expect(respondToToolSuspension).not.toHaveBeenCalled();
  });

  it('approves the call a followed work session is holding, and audits it as the person', async () => {
    const { answer, respondToToolApproval, record } = setup();

    await expect(answer({ decision: 'approve' })).resolves.toEqual({
      answered: 'approve',
      sessionId: WORKER,
      toolCallId: 'call-1',
    });

    expect(respondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'approve', toolCallId: 'call-1' }),
    );
    const { requestContext } = respondToToolApproval.mock.calls[0]![0] as {
      requestContext: { get(key: string): unknown };
    };
    expect(requestContext.get('user')).toEqual({ workosId: 'someone-else', organizationId: 'org-1' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        actorType: 'human',
        actorProfile: { name: 'Ada' },
        action: 'factory.run.approved',
        targets: [
          { type: 'session', id: WORKER },
          { type: 'work_item', id: ITEM },
        ],
        metadata: { toolCallId: 'call-1', sessionId: WORKER, decision: 'approve', cause: 'factory_tools' },
      }),
    );
  });

  it('declines with the reason the session will see', async () => {
    const { answer, respondToToolApproval, record } = setup();
    await answer({ decision: 'decline', reason: 'Keep it in triage.' });

    expect(respondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'decline',
        toolCallId: 'call-1',
        declineContext: { reason: 'Keep it in triage.' },
      }),
    );
    const { requestContext } = respondToToolApproval.mock.calls[0]![0] as {
      requestContext: { get(key: string): unknown };
    };
    expect(requestContext.get('user')).toEqual({ workosId: 'someone-else', organizationId: 'org-1' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'factory.run.dismissed' }));
  });

  it('lets the session that started a side session answer it', async () => {
    const { answer, respondToToolApproval } = setup({ row: { originSessionId: 'origin-session' }, binding: false });
    await answer({ decision: 'approve' });
    expect(respondToToolApproval).toHaveBeenCalled();
  });

  it('refuses a session it neither follows nor started, answering nothing', async () => {
    const { answer, respondToToolApproval } = setup({ follows: false });
    await expect(answer({ decision: 'approve' })).rejects.toThrow("doesn't follow session");
    expect(respondToToolApproval).not.toHaveBeenCalled();
  });

  it("refuses another person's private session and a session from another Factory", async () => {
    await expect(setup({ row: { visibility: 'private' } }).answer({ decision: 'approve' })).rejects.toThrow(
      'is private to its owner',
    );
    await expect(setup({ row: { factoryProjectId: 'other' } }).answer({ decision: 'approve' })).rejects.toThrow(
      'was not found in this Factory',
    );
  });

  it('says so when nothing is waiting any more, because the run ended or the session is gone', async () => {
    for (const options of [{ armed: false }, { live: false }]) {
      const { answer, respondToToolApproval } = setup(options);
      await expect(answer({ decision: 'approve' })).rejects.toThrow('Nothing is waiting on that tool call any more');
      expect(respondToToolApproval).not.toHaveBeenCalled();
    }
  });

  it('lets one of two answers arriving together resume the call, and tells the other it was answered', async () => {
    const { answer, respondToToolSuspension, record } = setup({ armed: false, parkedTool: 'sign_off' });
    const { promise: resuming, resolve: resumed } = Promise.withResolvers<void>();
    const consume = respondToToolSuspension.getMockImplementation()!;
    respondToToolSuspension.mockImplementationOnce(async input => {
      await resuming;
      await consume(input);
    });

    const first = answer({ decision: 'approve' });
    const second = answer({ decision: 'decline', reason: 'Not yet.' });
    await expect(second).rejects.toThrow('That call was already answered');
    resumed();

    await expect(first).resolves.toMatchObject({ answered: 'approve' });
    expect(respondToToolSuspension).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not report an answer the session could not carry on from, and leaves the call open to answer', async () => {
    const { answer, respondToToolSuspension, record } = setup({ armed: false, parkedTool: 'sign_off' });
    // The session reports a failed resume to its own stream and returns; the call still waits.
    respondToToolSuspension.mockImplementationOnce(async () => {});

    await expect(answer({ decision: 'approve' })).rejects.toThrow('The answer did not reach sign_off');
    expect(record).not.toHaveBeenCalled();

    await expect(answer({ decision: 'approve' })).resolves.toMatchObject({ answered: 'approve' });
  });

  it('tells a second answer to a held call that it was already answered', async () => {
    const { answer, respondToToolApproval } = setup();
    respondToToolApproval.mockReturnValueOnce({ accepted: false, reason: 'not_pending' } as never);
    await expect(answer({ decision: 'approve' })).rejects.toThrow('That call was already answered');
  });

  it('reports an answer the session refused', async () => {
    const { answer, respondToToolApproval, record } = setup();
    respondToToolApproval.mockReturnValueOnce({ accepted: false, reason: 'aborting' } as never);
    await expect(answer({ decision: 'approve' })).rejects.toThrow('not accepted (aborting)');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('answering without naming the tool call', () => {
  const session = { sessionId: WORKER, userId: 'someone-else', orgId: 'org-1' };
  const answerOnly = (live: unknown) =>
    answerParkedCall(
      { messaging: async () => ({ controller: { getSession: async () => live } }) as never },
      { session, decision: 'approve', declineReason: 'No.' },
    );

  it('answers the one call that is waiting', async () => {
    const { session: live, respondToToolApproval } = setup();

    await expect(answerOnly(live)).resolves.toEqual({
      toolCallId: 'call-1',
      toolName: 'factory_transition_work_item',
    });
    expect(respondToToolApproval).toHaveBeenCalledOnce();
  });

  it('asks which call to answer when several are waiting, answering none', async () => {
    const { session: live, respondToToolApproval, respondToToolSuspension } = setup({ parkedTool: 'sign_off' });
    live.displayState.get = () => ({
      pendingSuspensions: new Map([
        ['run-address', { toolCallId: 'call-2', toolName: 'sign_off', resumeSchema: RESUME_SCHEMAS.sign_off }],
      ]),
    });

    await expect(answerOnly(live)).rejects.toThrow(
      'This session waits on 2 approvals (factory_transition_work_item: call-1, sign_off: call-2). Name the toolCallId to answer.',
    );
    expect(respondToToolApproval).not.toHaveBeenCalled();
    expect(respondToToolSuspension).not.toHaveBeenCalled();
  });

  it('says to open the session when it waits on no approval', async () => {
    const { session: live } = setup({ armed: false, parkedTool: 'ask_user' });

    await expect(answerOnly(live)).rejects.toThrow('This session is not waiting on an approval. Open it');
  });
});

// fork(claude-agent)
describe('answering a Claude Agent session', () => {
  const session = { sessionId: WORKER, userId: 'someone-else', orgId: 'org-1' };
  function onRuntime(waiting: Array<{ toolCallId: string; toolName: string }>, runs = true) {
    const getSession = vi.fn(async () => null);
    const answer = vi.fn(async () => 'answered' as const);
    const runtime = {
      runs: vi.fn(async () => runs),
      isRunning: () => false,
      message: vi.fn(),
      approvals: { waiting: async () => waiting, answer },
    };
    const messaging = async () => ({ controller: { getSession }, runtime }) as never;
    return { messaging, getSession, answer, runtime };
  }

  it("answers through its runtime as the session's owner, never through the controller", async () => {
    const { messaging, getSession, answer } = onRuntime([{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }]);

    await expect(
      answerParkedCall(
        { messaging },
        { session, decision: 'decline', declineReason: 'Split it in two.', answeredBy: 'user-1' },
      ),
    ).resolves.toEqual({ toolCallId: 'toolu_plan', toolName: 'submit_plan' });

    expect(answer).toHaveBeenCalledWith(
      WORKER,
      'toolu_plan',
      { decision: 'decline', reason: 'Split it in two.', answeredBy: 'user-1' },
      expect.anything(),
    );
    const requestContext = (answer.mock.calls[0] as unknown[])[3] as { get(key: string): unknown };
    expect(requestContext.get('user')).toEqual({ workosId: 'someone-else', organizationId: 'org-1' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('says what Mastra Code sessions say when nothing, or more than one call, waits', async () => {
    await expect(
      answerParkedCall({ messaging: onRuntime([]).messaging }, { session, decision: 'approve', declineReason: 'No.' }),
    ).rejects.toThrow('This session is not waiting on an approval. Open it');
    await expect(
      answerParkedCall(
        { messaging: onRuntime([{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }]).messaging },
        { session, toolCallId: 'toolu_gone', decision: 'approve', declineReason: 'No.' },
      ),
    ).rejects.toThrow('Nothing is waiting on that tool call any more');
    const two = onRuntime([
      { toolCallId: 'toolu_1', toolName: 'submit_plan' },
      { toolCallId: 'toolu_2', toolName: 'factory_delete' },
    ]);
    await expect(
      answerParkedCall({ messaging: two.messaging }, { session, decision: 'approve', declineReason: 'No.' }),
    ).rejects.toThrow('This session waits on 2 approvals (submit_plan: toolu_1, factory_delete: toolu_2).');
    expect(two.answer).not.toHaveBeenCalled();
  });

  it('tells a second answer that the call was already answered', async () => {
    const { messaging, answer } = onRuntime([{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }]);
    answer.mockResolvedValueOnce('not_pending' as never);
    await expect(
      answerParkedCall({ messaging }, { session, decision: 'approve', declineReason: 'No.' }),
    ).rejects.toThrow('That call was already answered');
  });

  it('leaves a Mastra Code session to the controller, as before', async () => {
    const { session: live, respondToToolApproval } = setup();
    const { runtime, answer } = onRuntime([{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }], false);

    await expect(
      answerParkedCall(
        { messaging: async () => ({ controller: { getSession: async () => live }, runtime }) as never },
        { session, decision: 'approve', declineReason: 'No.' },
      ),
    ).resolves.toEqual({ toolCallId: 'call-1', toolName: 'factory_transition_work_item' });
    expect(respondToToolApproval).toHaveBeenCalledOnce();
    expect(answer).not.toHaveBeenCalled();
  });
});

// fork(claude-agent)
describe('factory_answer_approval on a Claude Agent session', () => {
  function claudeTools({ row = {}, follows = true }: { row?: Record<string, unknown>; follows?: boolean } = {}) {
    const answer = vi.fn(async () => 'answered' as const);
    const getSession = vi.fn(async () => null);
    const runtime = {
      runs: vi.fn(async () => true),
      isRunning: () => false,
      message: vi.fn(),
      approvals: { waiting: async () => [{ toolCallId: 'toolu_plan', toolName: 'submit_plan' }], answer },
    };
    const record = vi.fn();
    const tools = createFactoryApprovalTools(scope, {
      sessions: {
        getBySessionId: async () =>
          ({
            sessionId: WORKER,
            orgId: 'org-1',
            factoryProjectId: 'project-1',
            userId: 'someone-else',
            visibility: 'org',
            originSessionId: null,
            ...row,
          }) as never,
      },
      workItems: {
        findActiveRunBindingForSession: async () => ({ workItemId: ITEM }) as never,
        listSessionSubscriptions: async () => (follows ? [{ workItemId: ITEM }] : []) as never,
      },
      auditRecorder: { record } as never,
      messaging: async () => ({ controller: { getSession }, runtime }) as never,
    });
    const run = (input: Record<string, unknown>) =>
      (
        tools.factory_answer_approval as unknown as { execute: (input: unknown, context: unknown) => Promise<unknown> }
      ).execute({ sessionId: WORKER, toolCallId: 'toolu_plan', ...input }, {});
    return { run, answer, getSession, record };
  }

  it('answers through the runtime as the person in this conversation, the run carrying on as the owner', async () => {
    const { run, answer, getSession, record } = claudeTools();

    await expect(run({ decision: 'decline', reason: 'Split it.' })).resolves.toEqual({
      answered: 'decline',
      sessionId: WORKER,
      toolCallId: 'toolu_plan',
    });
    expect(answer).toHaveBeenCalledWith(
      WORKER,
      'toolu_plan',
      { decision: 'decline', reason: 'Split it.', answeredBy: 'user-1' },
      expect.anything(),
    );
    const requestContext = (answer.mock.calls[0] as unknown[])[3] as { get(key: string): unknown };
    expect(requestContext.get('user')).toEqual({ workosId: 'someone-else', organizationId: 'org-1' });
    expect(getSession).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'factory.run.dismissed', actorId: 'user-1' }),
    );
  });

  it("refuses a session it doesn't follow, and another person's private one, answering nothing", async () => {
    const stranger = claudeTools({ follows: false });
    await expect(stranger.run({ decision: 'approve' })).rejects.toThrow("This session doesn't follow session");
    const hidden = claudeTools({ row: { visibility: 'private' } });
    await expect(hidden.run({ decision: 'approve' })).rejects.toThrow('is private to its owner');
    expect(stranger.answer).not.toHaveBeenCalled();
    expect(hidden.answer).not.toHaveBeenCalled();
  });
});

// fork(claude-agent): who may answer a question from another session, and what it takes.
describe('factory_answer_question', () => {
  it('lets the person who filed the card answer, telling the session who answered as it resumes', async () => {
    const { answerQuestion, respondToToolSuspension, record } = setup({ parkedTool: 'ask_user', filedBy: 'user-1' });

    await expect(answerQuestion({ answer: 'release' })).resolves.toMatchObject({
      answered: true,
      toolCallId: 'call-1',
    });

    expect(respondToToolSuspension).toHaveBeenCalledWith(
      expect.objectContaining({ resumeData: 'Answered by Ada: release' }),
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'factory.run.answered', actorId: 'user-1' }));
  });

  it("gives the session's owner's answer as it is", async () => {
    const { answerQuestion, respondToToolSuspension } = setup({ parkedTool: 'ask_user', row: { userId: 'user-1' } });
    await answerQuestion({ answer: ['main'] });
    expect(respondToToolSuspension).toHaveBeenCalledWith(expect.objectContaining({ resumeData: 'main' }));
  });

  it.each([
    ['a follower who neither owns the session nor filed the card', {}, QUESTION_ANSWERERS],
    [
      "a session that doesn't follow it",
      { follows: false, filedBy: 'user-1' },
      `This session doesn't follow session ${WORKER}`,
    ],
    [
      "another person's private session",
      { row: { visibility: 'private' }, filedBy: 'user-1' },
      `Session ${WORKER} is private to its owner.`,
    ],
    ['a turn no person started', { as: { interactive: false }, filedBy: 'user-1' }, 'answer a question'],
    [
      'the waiting session itself',
      { as: { sessionId: WORKER }, row: { userId: 'user-1' } },
      'This is the session that is waiting',
    ],
  ] as const)('refuses %s, leaving the question waiting', async (_case, options, message) => {
    const { answerQuestion, respondToToolSuspension, record } = setup({ parkedTool: 'ask_user', ...options });

    await expect(answerQuestion({ answer: 'main' })).rejects.toThrow(message);

    expect(respondToToolSuspension).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses the waiting session approving its own call, too', async () => {
    const { answer, respondToToolApproval } = setup({ as: { sessionId: WORKER } });
    await expect(answer({ decision: 'approve' })).rejects.toThrow('This is the session that is waiting');
    expect(respondToToolApproval).not.toHaveBeenCalled();
  });

  it('refuses an answer that does not fit a single choice', async () => {
    const { answerQuestion, respondToToolSuspension } = setup({ parkedTool: 'ask_user', row: { userId: 'user-1' } });
    await expect(answerQuestion({ answer: ['main', 'release'] })).rejects.toThrow('This question takes one choice.');
    expect(respondToToolSuspension).not.toHaveBeenCalled();
  });
});
