// fork(claude-agent): mirror Mastra Code sessions into the runtime-neutral session event log.
import { HELD_INTERACTION_GONE, SessionPublisher } from '@factory/agent-runtime';
import type { InteractionBroker, InteractionRecord, SessionCommands, SessionEventHub } from '@factory/agent-runtime';
import { mastraCodeStillWaits, mirrorSessionEvents, observeMastraCodeInteractions } from '@factory/runtime-mastra-code';
import type { MastraCodeWaitCheckSession, MirrorableSession } from '@factory/runtime-mastra-code';

import { customModelContextWindow } from '../routes/custom-provider-source.js';

const mirrored = new WeakSet<object>();

/** Factory's interaction broker, as a Mastra Code session's waiting calls are recorded in it. */
export interface SessionInteractionRecords {
  broker: Pick<InteractionBroker, 'track' | 'settleHeld' | 'listPending'>;
  /** What the broker's index holds for one tool call of a session. */
  waitingOn(sessionId: string, callId: string): InteractionRecord[];
  /** Stop listing what the session holds for a call while its outcome is on its way. */
  hide?(sessionId: string, callId: string): void;
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
    /** Told synchronously when the controller ends a run, before its end is stored (see `noteSessionRunEnding`). */
    onRunEnding?: () => void;
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
  mirrorSessionEvents(
    session,
    event => {
      if (event.type === 'run.ended') options.onRunEnding?.();
      publisher.emit(event);
    },
    {
      onError: error => warnOnce('mapping an event', error),
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    },
  );
  if (options.interactions) recordSessionInteractions(session, options.interactions);
}

/**
 * Keep the interaction broker's records of a Mastra Code session's waiting calls as its controller
 * reports them. Each report waits for the one before it, so a call answered at once is recorded
 * before it is settled. Failures are logged, never surfaced to the session.
 */
function recordSessionInteractions(
  session: MirrorableSession,
  { broker, waitingOn, hide }: SessionInteractionRecords,
): void {
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
  /** What is kept pending for a call: the index, else the store (a record the index missed). */
  const heldFor = async (callId: string) => {
    const indexed = waitingOn(sessionId, callId);
    if (indexed.length > 0) return indexed;
    return (await broker.listPending({ sessionId })).filter(record => record.callId === callId);
  };
  observeMastraCodeInteractions(session, {
    requested: interaction => inTurn('recording a waiting call', () => broker.track(interaction)),
    left: callId => inTurn('letting go of a waiting call', async () => hide?.(sessionId, callId)),
    settled: (callId, settlement) =>
      inTurn('settling a waiting call', async () => {
        for (const record of await heldFor(callId)) {
          if (record.heldBy) await broker.settleHeld(record.id, settlement(record.request));
        }
      }),
  });
}

/**
 * After a restart, settle the held records read from storage whose Mastra Code session no longer
 * waits on their call: answered or dropped while no process watched it, or settled by a write that
 * failed. Each is checked against its controller and its storage without claiming it; a session
 * that was never started (`null`) waits on nothing. Bounded: at most `limit` records, each check at
 * most `timeoutMs`, one at a time; anything that can't be told stays pending. Returns how many settled.
 */
export async function settleHeldCallsGone({
  records,
  broker,
  session,
  limit = 100,
  timeoutMs = 10_000,
}: {
  records: InteractionRecord[];
  broker: Pick<InteractionBroker, 'settleHeld'>;
  /** The session to ask, recovered from storage if it isn't live; `null` when it was never started. */
  session(sessionId: string): Promise<MastraCodeWaitCheckSession | null | undefined>;
  limit?: number;
  timeoutMs?: number;
}): Promise<number> {
  const sessions = new Map<string, Promise<MastraCodeWaitCheckSession | null | undefined>>();
  let settled = 0;
  for (const record of records.filter(held => held.heldBy && held.status === 'pending').slice(0, limit)) {
    if (!record.callId) continue;
    const callId = record.callId;
    let waits: boolean | undefined;
    try {
      waits = await withTimeout(
        (async () => {
          if (!sessions.has(record.sessionId)) sessions.set(record.sessionId, session(record.sessionId));
          const held = await sessions.get(record.sessionId);
          if (held === null) return false;
          return held ? mastraCodeStillWaits(held, callId) : undefined;
        })(),
        timeoutMs,
      );
    } catch (error) {
      console.warn(`[factory] interactions: checking ${record.id} after a restart failed.`, error);
      continue;
    }
    if (waits !== false) continue;
    if (await broker.settleHeld(record.id, { status: 'cancelled', reason: HELD_INTERACTION_GONE })) settled++;
  }
  return settled;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Mastra Code's session commands, with who answered each of its held calls in the session itself
 * said to the broker before the answer goes to the controller (its own routes, outside the broker),
 * so the record names them once the controller reports the call settled. A refused answer names
 * nobody.
 */
export function attributingHeldAnswers(
  commands: SessionCommands,
  {
    broker,
    waitingOn,
    answeredBy,
  }: {
    broker: Pick<InteractionBroker, 'attribute'>;
    waitingOn: SessionInteractionRecords['waitingOn'];
    /** Who an answer's request is from. */
    answeredBy(context: unknown): string | undefined;
  },
): SessionCommands {
  return {
    ...commands,
    answer: async (sessionId, target, response, request) => {
      const callId = target.callId ?? target.interactionId?.slice(target.interactionId.indexOf(':') + 1).split('#')[0];
      const resolvedBy = answeredBy(request.context);
      const records = callId && resolvedBy ? waitingOn(sessionId, callId) : [];
      const record = records.find(held => held.id === target.interactionId) ?? records[0];
      const drop = record?.heldBy && resolvedBy ? broker.attribute(record.id, { resolvedBy }) : undefined;
      try {
        const result = await commands.answer(sessionId, target, response, request);
        if (!result.ok) drop?.();
        return result;
      } catch (error) {
        drop?.();
        throw error;
      }
    },
  };
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
