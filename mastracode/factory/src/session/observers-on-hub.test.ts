// fork(claude-agent): slice 6. Run reports, the run audit and the first-exec capture hear a Mastra Code
// session on Factory's event hub, fed by the real mirror, with events stored before they are heard.
import { InMemoryEventLog, SessionEventHub, SessionPublisher } from '@factory/agent-runtime';
import { mirrorSessionEvents } from '@factory/runtime-mastra-code';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it, vi } from 'vitest';

import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { observeSessionRunReports } from '../tools/run-watch.js';
import { observeSessionFirstExec } from './first-exec-capture.js';
import { observeSessionRunEnd, recordSessionRunStart } from './run-audit.js';

function setup() {
  const hub = new SessionEventHub(new InMemoryEventLog());
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  const session = {
    identity: { getId: () => 'session-1' },
    subscribe: (listener: (event: AgentControllerEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const publisher = new SessionPublisher(hub, 'session-1');
  mirrorSessionEvents(session, publisher.emit);
  const emit = (...events: object[]) => {
    for (const event of events) for (const listener of listeners) listener(event as AgentControllerEvent);
  };
  const settle = () => publisher.flush();
  return { hub, session, emit, settle };
}

describe('observers on the event hub', () => {
  it('reports a failed run with the error text, and joins the parked call to its run end', async () => {
    const { hub, emit, settle } = setup();
    const report = vi.fn(async () => {});
    observeSessionRunReports({ sessionId: 'session-1', events: hub }, report);

    emit(
      { type: 'agent_start' },
      { type: 'tool_start', toolCallId: 'c1', toolName: 'ask_user', args: {} },
      { type: 'tool_suspended', toolCallId: 'c1', toolName: 'ask_user', args: {}, suspendPayload: {} },
      { type: 'agent_end', reason: 'suspended' },
      { type: 'agent_start' },
      { type: 'error', error: new Error('Sandbox lease lost') },
      { type: 'agent_end', reason: 'error' },
    );
    await settle();

    // The suspended run says nothing here (its call is announced from the broker); the failed one quotes its error.
    expect(report.mock.calls.map(([outcome]) => outcome)).toEqual([
      { status: 'failed', reason: 'the run ended in error: Sandbox lease lost' },
    ]);
  });

  it('records a run end with the step usage the controller reported', async () => {
    const { hub, session, emit, settle } = setup();
    const { audit } = await createFactoryStorageForTests();
    const settings: Record<string, unknown> = {};
    const capture = {
      thread: {
        getSetting: async ({ key }: { key: string }) => settings[key],
        setSetting: async ({ key, value }: { key: string; value: unknown }) => void (settings[key] = value),
      },
    };
    observeSessionRunEnd(capture, { audit, events: hub, sessionId: session.identity.getId() });
    await recordSessionRunStart(capture, {
      audit,
      actorType: 'human',
      observedEnd: () => undefined,
      run: {
        kickoffId: 'k1',
        bindingId: 'b1',
        role: 'work',
        startedBy: 'u1',
        orgId: 'org-1',
        factoryProjectId: 'p1',
        workItemId: 'w1',
        sessionId: 'session-1',
        threadId: 't1',
        branch: 'factory/1',
      },
    });

    emit(
      { type: 'agent_start' },
      {
        type: 'usage_update',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheCreationInputTokens: 4 },
      },
      { type: 'agent_end', reason: 'complete' },
    );
    await settle();
    await vi.waitFor(async () => {
      const ended = (await audit.list({ orgId: 'org-1' })).events.find(e => e.action === 'factory.run.ended');
      expect(ended?.metadata).toMatchObject({
        reason: 'complete',
        usage: {
          status: 'recorded',
          totals: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheCreationInputTokens: 4 },
        },
      });
    });
  });

  it('marks the first meaningful exec on the first successful workspace tool', async () => {
    const { hub, session, emit, settle } = setup();
    const markFirstMeaningfulExec = vi.fn(async () => {});
    observeSessionFirstExec(session, { events: hub, sourceControl: { sessions: { markFirstMeaningfulExec } } });

    emit(
      { type: 'agent_start' },
      { type: 'tool_start', toolCallId: 'c1', toolName: 'execute_command', args: {} },
      { type: 'tool_end', toolCallId: 'c1', result: 'boom', isError: true },
      { type: 'tool_start', toolCallId: 'c2', toolName: 'view', args: {} },
      { type: 'tool_end', toolCallId: 'c2', result: 'ok', isError: false },
    );
    await settle();

    expect(markFirstMeaningfulExec).toHaveBeenCalledOnce();
  });
});
