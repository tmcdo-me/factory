import { describe, expect, it } from 'vitest';

import type { EventEnvelope, FactoryEvent } from './events';
import { applyEvent, buildTranscript, emptyTranscript, finishedToolCalls } from './transcript';

function envelopes(...events: FactoryEvent[]): EventEnvelope[] {
  return events.map((event, index) => ({ sessionId: 's', seq: index + 1, at: `t${index + 1}`, event }));
}

describe('transcript reducer', () => {
  it('builds a run with a streamed assistant message, merging consecutive deltas per part', () => {
    const transcript = buildTranscript(
      's',
      envelopes(
        {
          type: 'run.started',
          runId: 'r1',
          input: { kind: 'message', text: 'hi', author: { kind: 'user', userId: 'u' } },
        },
        { type: 'message.started', messageId: 'm1', role: 'assistant', runId: 'r1' },
        { type: 'message.delta', messageId: 'm1', part: 'reasoning', delta: 'think' },
        { type: 'message.delta', messageId: 'm1', part: 'reasoning', delta: 'ing' },
        { type: 'message.delta', messageId: 'm1', part: 'text', delta: 'Hel' },
        { type: 'message.delta', messageId: 'm1', part: 'text', delta: 'lo' },
        { type: 'message.ended', messageId: 'm1' },
        { type: 'run.ended', runId: 'r1', reason: 'complete' },
      ),
    );

    expect(transcript.lastSeq).toBe(8);
    expect(transcript.items).toMatchObject([
      { kind: 'run', runId: 'r1', status: 'complete', startedAt: 't1', endedAt: 't8' },
      {
        kind: 'message',
        complete: true,
        parts: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'Hello' },
        ],
      },
    ]);
  });

  it('tracks tool output and results, and reports finished calls by executor and seq', () => {
    const transcript = buildTranscript(
      's',
      envelopes(
        {
          type: 'tool.started',
          callId: 'c1',
          name: 'Bash',
          category: 'shell',
          executor: 'runtime',
          input: { command: 'ls' },
        },
        { type: 'tool.output', callId: 'c1', stream: 'stdout', chunk: 'a\n' },
        { type: 'tool.output', callId: 'c1', stream: 'stdout', chunk: 'b\n' },
        { type: 'tool.ended', callId: 'c1', result: { exitCode: 0 } },
        {
          type: 'tool.started',
          callId: 'c2',
          name: 'submit_plan',
          category: 'factory',
          executor: 'factory',
          input: {},
        },
        { type: 'tool.ended', callId: 'c2', error: 'rejected' },
        {
          type: 'tool.started',
          callId: 'c3',
          name: 'factory_record_review_verdict',
          category: 'factory',
          executor: 'factory',
          input: {},
        },
      ),
    );

    expect(transcript.items[0]).toMatchObject({
      status: 'done',
      stdout: 'a\nb\n',
      result: { exitCode: 0 },
      endedSeq: 4,
    });
    expect(finishedToolCalls(transcript, { executor: 'factory' }).map(t => [t.callId, t.status])).toEqual([
      ['c2', 'error'],
    ]);
    expect(finishedToolCalls(transcript, { afterSeq: 4 }).map(t => t.callId)).toEqual(['c2']);
  });

  it('records interaction lifecycle', () => {
    const transcript = buildTranscript(
      's',
      envelopes(
        {
          type: 'interaction.requested',
          interaction: {
            id: 'i1',
            sessionId: 's',
            request: { kind: 'plan_approval', planPath: 'p.md' },
            requestedAt: 't',
          },
        },
        {
          type: 'interaction.resolved',
          interactionId: 'i1',
          response: { kind: 'plan_approval', action: 'approved' },
          resolvedBy: 'u',
        },
      ),
    );
    expect(transcript.items[0]).toMatchObject({ kind: 'interaction', status: 'resolved', resolvedBy: 'u' });
  });

  it('ignores already-applied events (safe replay) and events for unknown items', () => {
    const [started, delta] = envelopes(
      { type: 'message.started', messageId: 'm1', role: 'assistant' },
      { type: 'message.delta', messageId: 'm1', part: 'text', delta: 'x' },
    );
    const once = applyEvent(applyEvent(emptyTranscript('s'), started!), delta!);
    const twice = applyEvent(once, delta!);
    expect(twice).toBe(once);

    const unknown = applyEvent(once, {
      sessionId: 's',
      seq: 3,
      at: 't3',
      event: { type: 'tool.ended', callId: 'nope' },
    });
    expect(unknown.items).toBe(once.items);
    expect(unknown.lastSeq).toBe(3);
  });

  it('streams tool input, records exits and denials, and keeps the latest progress', () => {
    const transcript = buildTranscript(
      's',
      envelopes(
        { type: 'tool.started', callId: 'c1', name: 'execute_command', category: 'shell', executor: 'runtime' },
        { type: 'tool.input.delta', callId: 'c1', delta: '{"command":' },
        { type: 'tool.input.delta', callId: 'c1', delta: '"ls"}' },
        { type: 'tool.input', callId: 'c1', input: { command: 'ls' } },
        { type: 'tool.progress', callId: 'c1', partial: { lines: 1 } },
        { type: 'tool.progress', callId: 'c1', partial: { lines: 2 } },
        { type: 'tool.ended', callId: 'c1', result: 'x', exit: { code: 2, timedOut: true } },
        { type: 'tool.started', callId: 'c2', name: 'push', category: 'factory', executor: 'factory', input: {} },
        { type: 'tool.ended', callId: 'c2', denied: true },
      ),
    );
    expect(transcript.items).toMatchObject([
      {
        callId: 'c1',
        inputText: '{"command":"ls"}',
        input: { command: 'ls' },
        progress: { lines: 2 },
        exit: { code: 2, timedOut: true },
        status: 'done',
      },
      { callId: 'c2', status: 'error', denied: true },
    ]);
  });

  it('merges late message metadata, keeps attachments, and records notices, subagents, tasks and usage', () => {
    const transcript = buildTranscript(
      's',
      envelopes(
        {
          type: 'message.started',
          messageId: 'u1',
          role: 'user',
          meta: { author: { id: 'u', name: 'Tim' }, steer: true },
          attachments: [{ mediaType: 'image/png', url: 'data:x', name: 'a.png' }],
        },
        { type: 'message.started', messageId: 'a1', role: 'assistant' },
        { type: 'message.meta', messageId: 'a1', meta: { modelId: 'anthropic/claude-opus-5-5' } },
        { type: 'message.meta', messageId: 'a1', meta: { credentialLabel: 'Claude Pro/Max' } },
        {
          type: 'notice',
          noticeId: 'n1',
          kind: 'reactive',
          tag: 'skill',
          text: 'factory-plan',
          attributes: { name: 'p' },
        },
        { type: 'subagent.started', callId: 't1', agentType: 'explore', task: 'find it', modelId: 'm' },
        { type: 'subagent.ended', callId: 't1', result: 'found' },
        { type: 'tasks.updated', tasks: [{ id: '1', title: 'Write tests', status: 'in_progress' }] },
        { type: 'usage', inputTokens: 10, outputTokens: 2, reasoningTokens: 1 },
        { type: 'error', message: 'No credentials', retryable: false, code: 'ProviderAuthRequiredError' },
      ),
    );
    expect(transcript.items).toMatchObject([
      { kind: 'message', meta: { author: { name: 'Tim' }, steer: true }, attachments: [{ name: 'a.png' }] },
      { kind: 'message', meta: { modelId: 'anthropic/claude-opus-5-5', credentialLabel: 'Claude Pro/Max' } },
      { kind: 'notice', noticeKind: 'reactive', tag: 'skill', text: 'factory-plan', attributes: { name: 'p' } },
      { kind: 'subagent', agentType: 'explore', status: 'done', result: 'found' },
      { kind: 'error', code: 'ProviderAuthRequiredError' },
    ]);
    expect(transcript.tasks).toEqual([{ id: '1', title: 'Write tests', status: 'in_progress' }]);
    expect(transcript.usage).toEqual({ inputTokens: 10, outputTokens: 2, reasoningTokens: 1 });
  });

  it('keeps identity of untouched items so UI memoization works', () => {
    const [m1, m2, d2] = envelopes(
      { type: 'message.started', messageId: 'm1', role: 'user' },
      { type: 'message.started', messageId: 'm2', role: 'assistant' },
      { type: 'message.delta', messageId: 'm2', part: 'text', delta: 'x' },
    );
    const before = applyEvent(applyEvent(emptyTranscript('s'), m1!), m2!);
    const after = applyEvent(before, d2!);
    expect(after.items[0]).toBe(before.items[0]);
    expect(after.items[1]).not.toBe(before.items[1]);
  });
});
