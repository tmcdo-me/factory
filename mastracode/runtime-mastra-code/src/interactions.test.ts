import { describe, expect, it } from 'vitest';

import { mastraCodeInteractionRequest } from './interactions';

const decision = JSON.stringify({
  type: 'object',
  properties: { action: { type: 'string', enum: ['approved', 'rejected'] }, feedback: { type: 'string' } },
  required: ['action'],
});

/** What a person outside the session is asked, for each kind of call a Mastra Code session holds. */
describe('mastraCodeInteractionRequest', () => {
  it('asks an ask_user question with its options, single or multiple', () => {
    const asked = (selectionMode?: string) =>
      mastraCodeInteractionRequest({
        toolCallId: 'c',
        toolName: 'ask_user',
        suspendPayload: {
          question: 'Which branch?',
          options: [{ label: 'main' }, { label: '' }, { label: 'release', description: 'Maintenance' }],
          ...(selectionMode ? { selectionMode } : {}),
        },
      });
    expect(asked('multi_select')).toEqual({
      kind: 'question',
      question: 'Which branch?',
      options: [{ label: 'main' }, { label: 'release', description: 'Maintenance' }],
      selection: 'multiple',
    });
    expect(asked()).toMatchObject({ selection: 'single' });
    expect(
      mastraCodeInteractionRequest({ toolCallId: 'c', toolName: 'ask_user', suspendPayload: { question: 'Why?' } }),
    ).toEqual({ kind: 'question', question: 'Why?' });
  });

  it('asks for a plan decision with the plan it carries, and a yes or no for another tool that resumes on one', () => {
    expect(
      mastraCodeInteractionRequest({
        toolCallId: 'c',
        toolName: 'submit_plan',
        resumeSchema: decision,
        suspendPayload: { path: 'plans/a.md', plan: '# A' },
      }),
    ).toEqual({ kind: 'plan_approval', planPath: 'plans/a.md', plan: '# A' });
    expect(
      mastraCodeInteractionRequest({ toolCallId: 'c', toolName: 'sign_off', resumeSchema: decision, args: { v: 1 } }),
    ).toEqual({ kind: 'tool_approval', toolName: 'sign_off', input: { v: 1 } });
  });

  it('marks a call waiting at its approval gate', () => {
    expect(mastraCodeInteractionRequest({ toolCallId: 'c', toolName: 'ship', args: { v: 1 }, gate: true })).toEqual({
      kind: 'tool_approval',
      toolName: 'ship',
      input: { v: 1 },
      gate: true,
    });
  });

  it('leaves a tool that needs more than a yes or no, or input of its own, to its session', () => {
    const ticket = JSON.stringify({
      type: 'object',
      properties: { action: { type: 'string', enum: ['approved', 'rejected'] }, ticket: { type: 'string' } },
      required: ['action', 'ticket'],
    });
    expect(mastraCodeInteractionRequest({ toolCallId: 'c', toolName: 'sign_off', resumeSchema: ticket })).toEqual({
      kind: 'tool_input',
      toolName: 'sign_off',
      input: null,
    });
    expect(
      mastraCodeInteractionRequest({
        toolCallId: 'c',
        toolName: 'request_access',
        args: { path: '/etc' },
        suspendPayload: { kind: 'sandbox_access_request', path: '/etc' },
      }),
    ).toEqual({ kind: 'tool_input', toolName: 'request_access', input: { path: '/etc' } });
  });
});
