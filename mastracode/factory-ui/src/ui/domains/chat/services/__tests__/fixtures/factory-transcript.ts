// fork(claude-agent)
import { buildTranscript } from '@factory/agent-runtime/browser';
import type { EventEnvelope, FactoryEvent, Transcript } from '@factory/agent-runtime/browser';

/** A transcript built from events in order, one second apart. */
export function transcriptOf(...events: FactoryEvent[]): Transcript {
  const envelopes: EventEnvelope[] = events.map((event, index) => ({
    sessionId: 's1',
    seq: index + 1,
    at: `2026-11-16T10:00:${String(index).padStart(2, '0')}.000Z`,
    event,
  }));
  return buildTranscript('s1', envelopes);
}
