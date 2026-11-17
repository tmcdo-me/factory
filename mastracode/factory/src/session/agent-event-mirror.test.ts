// fork(claude-agent)
import { InMemoryEventLog, InMemoryInteractionStore, InteractionBroker, SessionEventHub } from '@factory/agent-runtime';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it, vi } from 'vitest';

import { observeSessionAgentEvents, settleHeldCallsGone, stepModelId } from './agent-event-mirror.js';

function fakeSession(id = 's1') {
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  return {
    identity: { getId: () => id },
    subscribe(listener: (event: AgentControllerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: AgentControllerEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe('observeSessionAgentEvents', () => {
  it('stores mapped events in the session event log', async () => {
    const log = new InMemoryEventLog();
    const session = fakeSession();
    observeSessionAgentEvents(session, new SessionEventHub(log));

    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', reason: 'complete' });

    await vi.waitFor(async () =>
      expect((await log.list('s1')).map(e => e.event.type)).toEqual(['run.started', 'run.ended']),
    );
  });

  it('attaches only once per session object, however often Factory re-runs its session hooks', async () => {
    const log = new InMemoryEventLog();
    const hub = new SessionEventHub(log);
    const session = fakeSession();
    observeSessionAgentEvents(session, hub);
    observeSessionAgentEvents(session, hub);
    expect(session.listenerCount()).toBe(1);

    session.emit({ type: 'agent_start' });
    await vi.waitFor(async () => expect(await log.list('s1')).toHaveLength(1));
  });

  it('warns once and keeps the session running when storage fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = new SessionEventHub({
      append: async () => {
        throw new Error('db down');
      },
      list: async () => [],
    });
    const session = fakeSession('s2');
    observeSessionAgentEvents(session, failing);

    expect(() => {
      session.emit({ type: 'agent_start' });
      session.emit({ type: 'agent_end', reason: 'complete' });
    }).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]![0]).toContain('session s2');
    warn.mockRestore();
  });
});

// fork(claude-agent): which model a step's usage is metered against.
describe('stepModelId', () => {
  it("takes the reply's model, matching the provider's bare id to the session's model", () => {
    expect(stepModelId(undefined, 'self-hosted/qwen3.8-27b')).toBe('self-hosted/qwen3.8-27b');
    expect(stepModelId('qwen3.8-27b', 'self-hosted/qwen3.8-27b')).toBe('self-hosted/qwen3.8-27b');
    expect(stepModelId('self-hosted/small', 'self-hosted/big')).toBe('self-hosted/small');
    // A reply from before a switch to another model: its window isn't the new model's.
    expect(stepModelId('qwen3.8-27b', 'openai/gpt-5.4-mini')).toBeUndefined();
  });
});

// A restart: what was pending is read from storage, but a call may have been answered, dropped, or
// settled by a write that failed while no process watched it.
describe('settleHeldCallsGone', () => {
  it('settles the held calls their session no longer waits on, and keeps the rest', async () => {
    const store = new InMemoryInteractionStore();
    const broker = new InteractionBroker({ store, hub: new SessionEventHub(new InMemoryEventLog()) });
    const held = (sessionId: string, callId: string) =>
      broker.track({
        id: `question:${callId}`,
        sessionId,
        callId,
        heldBy: 'mastra-code',
        request: { kind: 'question', question: 'Which branch?' },
        requestedAt: new Date().toISOString(),
      });
    await held('s1', 'call-stored');
    await held('s1', 'call-gone');
    await held('s2', 'call-never');
    await held('s3', 'call-unknown');
    const stored = new Set(['call-stored']);
    const restored: string[] = [];
    const session = {
      approval: { list: () => [] },
      suspensions: {
        resolveAddress: ({ toolCallId }: { toolCallId: string }) => (restored.includes(toolCallId) ? {} : undefined),
      },
      hasPersistedToolApproval: async () => false,
      restoreStoredToolSuspension: async (toolCallId?: string) => {
        if (toolCallId && stored.has(toolCallId)) restored.push(toolCallId);
      },
    };

    const settled = await settleHeldCallsGone({
      records: await store.listPending(),
      broker,
      // s2 was never started; s3's controller can't tell.
      session: async sessionId => (sessionId === 's1' ? session : sessionId === 's2' ? null : undefined),
    });

    expect(settled).toBe(2);
    expect((await store.listPending()).map(record => record.id).sort()).toEqual([
      'question:call-stored',
      'question:call-unknown',
    ]);
  });
});
