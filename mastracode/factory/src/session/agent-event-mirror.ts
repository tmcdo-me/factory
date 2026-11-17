// fork(claude-agent): mirror Mastra Code sessions into the runtime-neutral session event log.
import { SessionPublisher } from '@factory/agent-runtime';
import type { InteractionBroker, InteractionRecord, SessionEventHub } from '@factory/agent-runtime';
import { mirrorSessionEvents, observeMastraCodeInteractions } from '@factory/runtime-mastra-code';
import type { MirrorableSession } from '@factory/runtime-mastra-code';

import { customModelContextWindow } from '../routes/custom-provider-source.js';

const mirrored = new WeakSet<object>();

/** Factory's interaction broker, as a Mastra Code session's waiting calls are recorded in it. */
export interface SessionInteractionRecords {
  broker: Pick<InteractionBroker, 'track' | 'settleHeld'>;
  /** What the broker's index holds for one tool call of a session. */
  waitingOn(sessionId: string, callId: string): InteractionRecord[];
}

/**
 * Shadow-write a Mastra Code session's events into Factory's event log (`@factory/agent-runtime`).
 * Read path only: nothing consumes the log yet, and failures are logged, never surfaced to the
 * session. Safe to call again for the same session object.
 */
export function observeSessionAgentEvents(
  session: MirrorableSession,
  hub: SessionEventHub,
  options: {
    /** The context window of the model that produced a step, when known (a custom provider's model). */
    contextWindow?: (modelId: string | undefined) => number | undefined;
    /** Factory's interaction broker, told of every call the session holds for a person and when it stops holding it. */
    interactions?: SessionInteractionRecords;
  } = {},
): void {
  if (mirrored.has(session)) return;
  mirrored.add(session);
  const sessionId = session.identity.getId();
  let warned = false;
  const warnOnce = (what: string, error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[factory] agent event log: ${what} for session ${sessionId} failed (further failures for this session are not logged): ${error instanceof Error ? error.message : error}`,
    );
  };
  const publisher = new SessionPublisher(hub, sessionId, { onError: error => warnOnce('storing events', error) });
  mirrorSessionEvents(session, publisher.emit, {
    onError: error => warnOnce('mapping an event', error),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
  });
  if (options.interactions) recordSessionInteractions(session, options.interactions);
}

/**
 * Keep the interaction broker's records of a Mastra Code session's waiting calls as its controller
 * reports them. Each report waits for the one before it, so a call answered at once is recorded
 * before it is settled. Failures are logged, never surfaced to the session.
 */
function recordSessionInteractions(session: MirrorableSession, { broker, waitingOn }: SessionInteractionRecords): void {
  const sessionId = session.identity.getId();
  let queue = Promise.resolve();
  const inTurn = (what: string, work: () => Promise<unknown>) => {
    queue = queue
      .then(work)
      .then(() => undefined)
      .catch(error =>
        console.warn(
          `[factory] interactions: ${what} for session ${sessionId} failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
  };
  observeMastraCodeInteractions(session, {
    requested: interaction => inTurn('recording a waiting call', () => broker.track(interaction)),
    settled: (callId, settlement) =>
      inTurn('settling a waiting call', async () => {
        for (const record of waitingOn(sessionId, callId)) {
          if (record.heldBy) await broker.settleHeld(record.id, settlement(record.request));
        }
      }),
  });
}

/**
 * The context window of the model a Mastra Code session runs now, when its organization's custom
 * provider sets one for it (Mastra's own catalog has none), read at each model step for the
 * composer's context meter.
 */
export function sessionModelContextWindow(session: {
  state: { get(): { factoryOrgId?: string } };
  model: { get(): string | undefined };
}): (modelId: string | undefined) => number | undefined {
  return replyModelId => {
    const current = session.model.get();
    return customModelContextWindow(session.state.get().factoryOrgId, stepModelId(replyModelId, current));
  };
}

/**
 * The model that produced a step: the one its reply names, else the one the session runs now. A
 * reply names its model as the provider knows it (`qwen3.8-27b`, no provider prefix), so a bare id
 * is the session's model when that ends with it; one that doesn't (the reply came before a model
 * switch) has no window to meter against.
 */
export function stepModelId(replyModelId: string | undefined, current: string | undefined): string | undefined {
  if (!replyModelId) return current;
  if (replyModelId.includes('/')) return replyModelId;
  return current === replyModelId || current?.endsWith(`/${replyModelId}`) ? current : undefined;
}
