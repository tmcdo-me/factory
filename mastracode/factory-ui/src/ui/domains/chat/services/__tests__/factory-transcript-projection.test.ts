// fork(claude-agent)
import { describe, expect, it } from 'vitest';

import { projectTranscript } from '../factory-transcript-projection';
import type { MessageEntry } from '../transcript';
import { transcriptOf } from './fixtures/factory-transcript';

const user = { kind: 'user', userId: 'u1' } as const;

describe('projectTranscript', () => {
  it('draws user and assistant messages with tool calls attached to the assistant turn', () => {
    const { entries, running } = projectTranscript(
      transcriptOf(
        { type: 'message.started', messageId: 'u1', role: 'user', meta: { author: { id: 'u1', name: 'Tim' } } },
        { type: 'message.delta', messageId: 'u1', part: 'text', delta: 'Fix the flaky test' },
        { type: 'message.ended', messageId: 'u1' },
        { type: 'run.started', runId: 'r1', input: { kind: 'message', text: 'Fix the flaky test', author: user } },
        { type: 'message.started', messageId: 'a1', role: 'assistant', runId: 'r1' },
        { type: 'message.delta', messageId: 'a1', part: 'reasoning', delta: 'Look first.' },
        { type: 'message.delta', messageId: 'a1', part: 'text', delta: 'Running it.' },
        {
          type: 'message.meta',
          messageId: 'a1',
          meta: { modelId: 'anthropic/claude-opus-5-5', credentialLabel: 'Claude Pro/Max' },
        },
        {
          type: 'tool.started',
          callId: 'c1',
          name: 'execute_command',
          category: 'shell',
          executor: 'runtime',
          runId: 'r1',
        },
        { type: 'tool.input.delta', callId: 'c1', delta: '{"command":"pnpm test"}' },
        { type: 'tool.input', callId: 'c1', input: { command: 'pnpm test' } },
        { type: 'tool.output', callId: 'c1', stream: 'stdout', chunk: 'FAIL x\n' },
        { type: 'tool.ended', callId: 'c1', result: { exitCode: 1 }, exit: { code: 1 } },
        { type: 'message.ended', messageId: 'a1' },
      ),
    );

    expect(running).toBe(true);
    expect(entries.map(e => [e.kind, e.id])).toEqual([
      ['message', 'u1'],
      ['message', 'a1'],
    ]);
    const [userEntry, assistant] = entries as MessageEntry[];
    expect(userEntry.message).toMatchObject({
      role: 'user',
      content: {
        parts: [{ type: 'text', text: 'Fix the flaky test' }],
        providerMetadata: { mastra: { author: { name: 'Tim' } } },
      },
    });
    expect(assistant.message.content).toMatchObject({
      parts: [
        { type: 'reasoning', reasoning: 'Look first.' },
        { type: 'text', text: 'Running it.' },
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'c1',
            toolName: 'execute_command',
            args: { command: 'pnpm test' },
          },
        },
      ],
      metadata: { modelId: 'anthropic/claude-opus-5-5', credentialLabel: 'Claude Pro/Max' },
    });
    expect(assistant.runtimeTools!.c1).toMatchObject({
      argsText: '{"command":"pnpm test"}',
      output: 'FAIL x\n',
      status: 'done',
      exit: { exitCode: 1 },
    });
    expect(assistant.streaming).toBeUndefined();
  });

  it('gives tool calls with no assistant message of their own a synthetic assistant entry', () => {
    const { entries } = projectTranscript(
      transcriptOf(
        { type: 'run.started', runId: 'r1' },
        {
          type: 'tool.started',
          callId: 'c1',
          name: 'view',
          category: 'file.read',
          executor: 'runtime',
          runId: 'r1',
          input: {},
        },
      ),
    );
    expect(entries).toMatchObject([
      {
        kind: 'message',
        id: 'assistant-tools-c1',
        streaming: true,
        message: { role: 'assistant', content: { parts: [{ toolInvocation: { state: 'call' } }] } },
      },
    ]);
  });

  it('maps denied and failed tools to the invocation states the renderers know', () => {
    const { entries } = projectTranscript(
      transcriptOf(
        { type: 'message.started', messageId: 'a1', role: 'assistant' },
        { type: 'tool.started', callId: 'd', name: 'push', category: 'factory', executor: 'factory', input: {} },
        { type: 'tool.ended', callId: 'd', denied: true },
        { type: 'tool.started', callId: 'e', name: 'view', category: 'file.read', executor: 'runtime', input: {} },
        { type: 'tool.ended', callId: 'e', error: 'ENOENT' },
      ),
    );
    const parts = (entries[0] as MessageEntry).message.content.parts as {
      toolInvocation: { state: string; errorText?: string };
    }[];
    expect(parts.map(p => [p.toolInvocation.state, p.toolInvocation.errorText])).toEqual([
      ['output-denied', 'Denied'],
      ['output-error', 'ENOENT'],
    ]);
  });

  // fork(claude-agent)
  it('shows a tool the person stopped as stopped, not as a failure', () => {
    const { entries } = projectTranscript(
      transcriptOf(
        { type: 'message.started', messageId: 'a1', role: 'assistant' },
        { type: 'tool.started', callId: 'q', name: 'ask_user', category: 'factory', executor: 'factory', input: {} },
        { type: 'tool.ended', callId: 'q', error: 'Stopped', stopped: true },
      ),
    );
    const message = (entries[0] as MessageEntry).message;
    const parts = message.content.parts as { toolInvocation: { state: string; result?: unknown } }[];
    expect(parts.map(p => [p.toolInvocation.state, p.toolInvocation.result])).toEqual([['result', 'Stopped']]);
    // What the tool cards (the question card included) read: done, not an error.
    const runtimeTools = (
      entries[0] as MessageEntry & { runtimeTools?: Record<string, { status: string; result?: unknown }> }
    ).runtimeTools;
    expect(runtimeTools?.q).toMatchObject({ status: 'done', result: 'Stopped' });
  });

  it('turns pending interactions into prompt cards and drops settled ones', () => {
    const interaction = (id: string, callId: string, request: never) => ({
      type: 'interaction.requested' as const,
      interaction: { id, sessionId: 's1', callId, request, requestedAt: 't' },
    });
    const { entries } = projectTranscript(
      transcriptOf(
        { type: 'message.started', messageId: 'a1', role: 'assistant' },
        {
          type: 'tool.started',
          callId: 'q',
          name: 'ask_user',
          category: 'factory',
          executor: 'factory',
          input: { question: 'Which DB?' },
        },
        interaction('i-q', 'q', {
          kind: 'question',
          question: 'Which DB?',
          options: [{ label: 'PG' }],
          selection: 'multiple',
        } as never),
        {
          type: 'tool.started',
          callId: 'p',
          name: 'submit_plan',
          category: 'factory',
          executor: 'factory',
          input: { path: 'plan.md' },
        },
        interaction('i-p', 'p', { kind: 'plan_approval', planPath: 'plan.md' } as never),
        {
          type: 'tool.started',
          callId: 't',
          name: 'factory_transition_work_item',
          category: 'factory',
          executor: 'factory',
          input: { stage: 'done' },
        },
        interaction('i-t', 't', {
          kind: 'tool_approval',
          toolName: 'factory_transition_work_item',
          input: { stage: 'done' },
        } as never),
        interaction('i-old', 'old', { kind: 'question', question: 'old' } as never),
        { type: 'interaction.resolved', interactionId: 'i-old', response: { kind: 'question', answer: 'x' } },
      ),
    );
    const prompts = entries.filter(e => e.kind === 'approval' || e.kind === 'suspension');
    expect(prompts).toEqual([
      {
        kind: 'suspension',
        id: 'suspension-q',
        toolCallId: 'q',
        toolName: 'ask_user',
        args: { question: 'Which DB?' },
        suspendPayload: { question: 'Which DB?', options: [{ label: 'PG' }], selectionMode: 'multi_select' },
      },
      {
        kind: 'suspension',
        id: 'suspension-p',
        toolCallId: 'p',
        toolName: 'submit_plan',
        args: { path: 'plan.md' },
        suspendPayload: { path: 'plan.md' },
      },
      {
        kind: 'approval',
        id: 'approval-t',
        toolCallId: 't',
        toolName: 'factory_transition_work_item',
        args: { stage: 'done' },
      },
    ]);
  });

  it('draws notices as signal rows, plus subagents, errors and tasks', () => {
    const { entries, tasks } = projectTranscript(
      transcriptOf(
        {
          type: 'notice',
          noticeId: 'n1',
          kind: 'reactive',
          tag: 'skill',
          text: 'factory-plan',
          attributes: { name: 'factory-plan' },
        },
        { type: 'subagent.started', callId: 's', agentType: 'explore', task: 'look' },
        { type: 'error', message: 'Sign in to continue', retryable: false, code: 'ProviderAuthRequiredError' },
        { type: 'tasks.updated', tasks: [{ id: '1', title: 'Write tests', status: 'pending' }] },
      ),
    );
    expect(entries).toMatchObject([
      {
        kind: 'message',
        id: 'n1',
        message: {
          role: 'signal',
          content: {
            metadata: {
              signal: {
                type: 'reactive',
                tagName: 'skill',
                contents: 'factory-plan',
                attributes: { name: 'factory-plan' },
              },
            },
          },
        },
      },
      { kind: 'subagent', toolCallId: 's', agentType: 'explore', task: 'look', modelId: '', done: false },
      { kind: 'notice', level: 'error', text: 'Sign in to continue', error: { name: 'ProviderAuthRequiredError' } },
    ]);
    expect(tasks).toEqual([{ id: '1', content: 'Write tests', status: 'pending', activeForm: 'Write tests' }]);
  });
});
