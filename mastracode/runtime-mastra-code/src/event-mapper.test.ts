import { buildTranscript } from '@factory/agent-runtime';
import type { EventEnvelope, FactoryEvent } from '@factory/agent-runtime';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it } from 'vitest';

import { MastraCodeEventMapper } from './event-mapper';
import { mirrorSessionEvents } from './mirror';
import { classifyMastraCodeTool } from './tool-classification';

type MessageStart = Extract<AgentControllerEvent, { type: 'message_start' }>;

function message(id: string, role: string, parts: unknown[] = []): MessageStart {
  return {
    type: 'message_start',
    message: { id, role, createdAt: new Date(0), content: { format: 2, parts } } as unknown as MessageStart['message'],
  };
}

function mapAll(events: AgentControllerEvent[]): FactoryEvent[] {
  let n = 0;
  const mapper = new MastraCodeEventMapper({ sessionId: 's1', newRunId: () => `run-${++n}`, now: () => new Date(0) });
  return events.flatMap(event => mapper.map(event));
}

function toTranscript(events: FactoryEvent[]) {
  const envelopes: EventEnvelope[] = events.map((event, index) => ({
    sessionId: 's1',
    seq: index + 1,
    at: 't',
    event,
  }));
  return buildTranscript('s1', envelopes);
}

describe('MastraCodeEventMapper', () => {
  it('maps a full plan-approval session into a coherent transcript', () => {
    const events = mapAll([
      // Mastra Code's real shape for a typed user turn (see mirror.integration.test.ts).
      message('u1', 'signal', [
        { type: 'data-user-message', data: { type: 'user', tagName: 'user', contents: 'Fix the flaky test' } },
      ]),
      { type: 'message_end', id: 'u1' },
      { type: 'agent_start' },
      message('a1', 'assistant'),
      { type: 'message_update', id: 'a1', event: { type: 'reasoning-delta', index: 0, delta: 'Look at ' } },
      { type: 'message_update', id: 'a1', event: { type: 'reasoning-delta', index: 0, delta: 'the test' } },
      { type: 'message_update', id: 'a1', event: { type: 'text-delta', delta: 'Running it.' } },
      { type: 'tool_start', toolCallId: 'c1', toolName: 'execute_command', args: { command: 'pnpm test' } },
      { type: 'shell_output', toolCallId: 'c1', output: 'FAIL x\n', stream: 'stdout' },
      { type: 'command_exit', toolCallId: 'c1', exitCode: 1, success: false },
      { type: 'tool_end', toolCallId: 'c1', result: { exitCode: 1 }, isError: false },
      { type: 'tool_start', toolCallId: 'c2', toolName: 'submit_plan', args: { path: '.artifacts/plans/fix.md' } },
      {
        type: 'tool_suspended',
        toolCallId: 'c2',
        toolName: 'submit_plan',
        args: { path: '.artifacts/plans/fix.md' },
        suspendPayload: {},
      },
      { type: 'message_end', id: 'a1' },
      { type: 'agent_end', reason: 'suspended' },
      // human approves; Mastra resumes the run
      { type: 'agent_start' },
      { type: 'tool_start', toolCallId: 'c2', toolName: 'submit_plan', args: { path: '.artifacts/plans/fix.md' } },
      { type: 'tool_end', toolCallId: 'c2', result: { submittedPlan: { action: 'approved' } }, isError: false },
      message('a2', 'assistant', [{ type: 'text', text: 'Implementing.' }]),
      { type: 'message_end', id: 'a2' },
      {
        type: 'usage_update',
        usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedInputTokens: 800 },
      },
      { type: 'agent_end', reason: 'complete' },
    ]);

    const transcript = toTranscript(events);
    expect(transcript.items.map(item => item.kind)).toEqual([
      'message', // u1
      'run', // run-1
      'message', // a1
      'tool', // c1
      'tool', // c2
      'interaction',
      'run', // run-2
      'message', // a2
    ]);
    expect(transcript.items).toMatchObject([
      { kind: 'message', role: 'user', parts: [{ type: 'text', text: 'Fix the flaky test' }], complete: true },
      { kind: 'run', runId: 'run-1', status: 'awaiting_interaction' },
      {
        kind: 'message',
        role: 'assistant',
        runId: 'run-1',
        parts: [
          { type: 'reasoning', text: 'Look at the test' },
          { type: 'text', text: 'Running it.' },
        ],
      },
      { kind: 'tool', callId: 'c1', category: 'shell', executor: 'runtime', stdout: 'FAIL x\n', status: 'done' },
      { kind: 'tool', callId: 'c2', name: 'submit_plan', category: 'factory', executor: 'factory', status: 'done' },
      {
        kind: 'interaction',
        status: 'resolved',
        interaction: {
          id: 'plan_approval:c2',
          callId: 'c2',
          request: { kind: 'plan_approval', planPath: '.artifacts/plans/fix.md' },
        },
        response: { kind: 'plan_approval', action: 'approved' },
      },
      { kind: 'run', runId: 'run-2', status: 'complete' },
      { kind: 'message', parts: [{ type: 'text', text: 'Implementing.' }], complete: true },
    ]);
    expect(events).toContainEqual({
      type: 'usage',
      runId: 'run-2',
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 800,
    });
  });

  it('records a denied approval as a resolved interaction and an errored tool call', () => {
    const transcript = toTranscript(
      mapAll([
        { type: 'agent_start' },
        { type: 'tool_start', toolCallId: 'c1', toolName: 'factory_transition_work_item', args: { stage: 'done' } },
        {
          type: 'tool_approval_required',
          toolCallId: 'c1',
          toolName: 'factory_transition_work_item',
          args: { stage: 'done' },
        },
        { type: 'tool_end', toolCallId: 'c1', result: undefined, isError: false, denied: true },
        { type: 'agent_end', reason: 'complete' },
      ]),
    );
    expect(transcript.items).toMatchObject([
      { kind: 'run', status: 'complete' },
      { kind: 'tool', status: 'error', error: 'denied' },
      { kind: 'interaction', status: 'resolved', response: { kind: 'tool_approval', approved: false } },
    ]);
  });

  it('maps ask_user suspensions to questions and cancellations to cancelled interactions', () => {
    const events = mapAll([
      { type: 'tool_start', toolCallId: 'q1', toolName: 'ask_user', args: {} },
      {
        type: 'tool_suspended',
        toolCallId: 'q1',
        toolName: 'ask_user',
        args: {
          question: 'Which DB?',
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
          selectionMode: 'multi_select',
        },
        suspendPayload: {},
      },
      { type: 'tool_suspension_cancelled', toolCallId: 'q1', toolName: 'ask_user', reason: 'aborted' },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'interaction.requested',
        interaction: expect.objectContaining({
          request: {
            kind: 'question',
            question: 'Which DB?',
            options: [
              { label: 'Postgres', description: undefined },
              { label: 'SQLite', description: undefined },
            ],
            selection: 'multiple',
          },
        }),
      }),
    );
    expect(events.at(-1)).toEqual({ type: 'interaction.cancelled', interactionId: 'question:q1', reason: 'aborted' });
  });

  it('ignores Mastra-only events, signal messages, and updates for unknown messages or tools', () => {
    expect(
      mapAll([
        message('sig', 'signal', [
          { type: 'data-signal', data: { tagName: 'factory-work-item', contents: '<card/>' } },
        ]),
        { type: 'message_update', id: 'sig', event: { type: 'text-delta', delta: 'x' } },
        { type: 'message_end', id: 'sig' },
        message('rem', 'signal', [{ type: 'data-system-reminder', data: { contents: 'remember' } }]),
        { type: 'message_update', id: 'nope', event: { type: 'text-delta', delta: 'x' } },
        { type: 'shell_output', toolCallId: 'nope', output: 'x', stream: 'stdout' },
        { type: 'tool_end', toolCallId: 'nope', result: 1, isError: false },
        { type: 'thread_title_updated', threadId: 't', title: 'x' },
        { type: 'task_updated', tasks: [] },
        { type: 'om_observation_start', cycleId: 'c', operationType: 'observation', tokensToObserve: 1 },
        { type: 'agent_end', reason: 'complete' }, // no open run
      ]),
    ).toEqual([]);
  });

  it('closes a dangling run when a new one starts, and reports errors', () => {
    expect(
      mapAll([
        { type: 'agent_start' },
        { type: 'agent_start' },
        { type: 'error', error: new Error('rate limited'), retryable: true },
      ]),
    ).toEqual([
      { type: 'run.started', runId: 'run-1' },
      { type: 'run.ended', runId: 'run-1', reason: 'complete' },
      { type: 'run.started', runId: 'run-2' },
      { type: 'error', message: 'rate limited', retryable: true, runId: 'run-2' },
    ]);
  });
});

describe('user messages', () => {
  it('reads data-user-message contents given as an array, and plain user-role messages', () => {
    const events = mapAll([
      message('u1', 'signal', [
        { type: 'data-user-message', data: { contents: ['line one', { text: 'line two' }, 7] } },
      ]),
      message('u2', 'user', [{ type: 'text', text: 'persisted form' }]),
    ]);
    expect(events).toEqual([
      { type: 'message.started', messageId: 'u1', role: 'user' },
      { type: 'message.delta', messageId: 'u1', part: 'text', delta: 'line one\nline two' },
      { type: 'message.started', messageId: 'u2', role: 'user' },
      { type: 'message.delta', messageId: 'u2', part: 'text', delta: 'persisted form' },
    ]);
  });
});

describe('classifyMastraCodeTool', () => {
  it('classifies Mastra Code tools by category and everything else as Factory tools', () => {
    expect(classifyMastraCodeTool('execute_command')).toEqual({ category: 'shell', executor: 'runtime' });
    expect(classifyMastraCodeTool('view')).toEqual({ category: 'file.read', executor: 'runtime' });
    expect(classifyMastraCodeTool('string_replace_lsp')).toEqual({ category: 'file.write', executor: 'runtime' });
    expect(classifyMastraCodeTool('search_content')).toEqual({ category: 'search', executor: 'runtime' });
    expect(classifyMastraCodeTool('source_control_push')).toEqual({ category: 'factory', executor: 'factory' });
  });
});

describe('mirrorSessionEvents', () => {
  it('forwards mapped events and isolates mapping failures from the session', () => {
    let listener: ((event: AgentControllerEvent) => void) | undefined;
    const session = {
      identity: { getId: () => 's1' },
      subscribe: (l: (event: AgentControllerEvent) => void) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    };
    const emitted: FactoryEvent[] = [];
    const errors: unknown[] = [];
    const unsubscribe = mirrorSessionEvents(
      session,
      event => {
        if (event.type === 'error') throw new Error('emit failed');
        emitted.push(event);
      },
      { onError: error => errors.push(error) },
    );

    listener!({ type: 'agent_start' });
    expect(() => listener!({ type: 'error', error: new Error('x') })).not.toThrow();
    expect(emitted.map(e => e.type)).toEqual(['run.started']);
    expect(errors).toHaveLength(1);

    unsubscribe();
    expect(listener).toBeUndefined();
  });
});
