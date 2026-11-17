import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it, vi } from 'vitest';

import { hubOf } from './controller-event-hub.js';
import { observeSessionFirstMessage } from './first-message-capture.js';
import type { FirstMessageCaptureDependencies, FirstMessageCaptureSession } from './first-message-capture.js';

function createSession() {
  const listeners: Array<(event: AgentControllerEvent) => void> = [];
  const session: FirstMessageCaptureSession = {
    identity: { getId: () => 'resource-1' },
    subscribe: listener => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
  };
  const emit = (event: AgentControllerEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { session, listeners, emit };
}

function createDependencies(): FirstMessageCaptureDependencies {
  return {
    events: { listen: () => () => undefined },
    sourceControl: { sessions: { markFirstMessage: vi.fn().mockResolvedValue(undefined) } },
  };
}

function messageWith(role: MastraDBMessage['role'], id = 'msg-1'): MastraDBMessage {
  return {
    id,
    role,
    createdAt: new Date(),
    content: { format: 2, parts: [] },
  };
}

describe('observeSessionFirstMessage', () => {
  it('marks the first message on the first assistant message_start and unsubscribes', () => {
    const { session, listeners, emit } = createSession();
    const dependencies = createDependencies();
    observeSessionFirstMessage(session, { ...dependencies, events: hubOf(session).events });

    emit({ type: 'message_start', message: messageWith('assistant') });

    expect(dependencies.sourceControl.sessions.markFirstMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'resource-1',
    });
    expect(listeners).toHaveLength(0);
  });

  it('marks the first message on a user message_start too', () => {
    const { session, emit } = createSession();
    const dependencies = createDependencies();
    observeSessionFirstMessage(session, { ...dependencies, events: hubOf(session).events });

    emit({ type: 'message_start', message: messageWith('user') });

    expect(dependencies.sourceControl.sessions.markFirstMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'resource-1',
    });
  });

  it('ignores signal and system messages and non-message events', () => {
    const { session, emit } = createSession();
    const dependencies = createDependencies();
    observeSessionFirstMessage(session, { ...dependencies, events: hubOf(session).events });

    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: messageWith('signal') });
    emit({ type: 'message_start', message: messageWith('system') });
    emit({ type: 'thread_changed', threadId: 'thread-2', previousThreadId: 'thread-1' });
    emit({ type: 'agent_end', reason: 'complete' });
    expect(dependencies.sourceControl.sessions.markFirstMessage).not.toHaveBeenCalled();

    emit({ type: 'message_start', message: messageWith('assistant') });
    emit({ type: 'message_start', message: messageWith('assistant', 'msg-2') });
    expect(dependencies.sourceControl.sessions.markFirstMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores a typed message the runtime delivered as a signal, then marks the first real one', () => {
    const { session, emit } = createSession();
    const dependencies = createDependencies();
    observeSessionFirstMessage(session, { ...dependencies, events: hubOf(session).events });

    const typed = messageWith('signal', 'sig-1');
    typed.content = {
      format: 2,
      parts: [{ type: 'data-user-message', data: { contents: 'hello' } } as never],
    };
    emit({ type: 'message_start', message: typed });
    expect(dependencies.sourceControl.sessions.markFirstMessage).not.toHaveBeenCalled();

    emit({ type: 'message_start', message: messageWith('assistant') });
    expect(dependencies.sourceControl.sessions.markFirstMessage).toHaveBeenCalledOnce();
  });

  it('warns instead of throwing when the storage write fails', async () => {
    const { session, emit } = createSession();
    const dependencies = createDependencies();
    dependencies.sourceControl.sessions.markFirstMessage = vi.fn().mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    observeSessionFirstMessage(session, { ...dependencies, events: hubOf(session).events });

    emit({ type: 'message_start', message: messageWith('assistant') });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[Factory first-message capture] Unable to persist first message time.',
        expect.any(Error),
      ),
    );
    warn.mockRestore();
  });

  it('stops observing when the returned unsubscribe is called before any message', () => {
    const { session, listeners, emit } = createSession();
    const dependencies = createDependencies();
    const unsubscribe = observeSessionFirstMessage(session, { ...dependencies, events: hubOf(session).events });

    unsubscribe();
    expect(listeners).toHaveLength(0);

    emit({ type: 'message_start', message: messageWith('assistant') });
    expect(dependencies.sourceControl.sessions.markFirstMessage).not.toHaveBeenCalled();
  });
});
