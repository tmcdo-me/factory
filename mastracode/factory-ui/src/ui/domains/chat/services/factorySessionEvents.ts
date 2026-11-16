// fork(claude-agent): client for Factory's runtime-neutral session API.
import type { EventEnvelope, Transcript } from '@factory/agent-runtime/browser';

import { readSSE } from '../../../lib/readSSE';

/** The server pings every 25 s; a stream silent for this long has nobody on the other end. */
const SILENCE_LIMIT_MS = 60_000;

const sessionPath = (baseUrl: string, sessionId: string) =>
  `${baseUrl}/web/factory/sessions/${encodeURIComponent(sessionId)}`;

export class FactorySessionRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FactorySessionRequestError';
    this.status = status;
  }
}

export async function fetchFactoryTranscript(
  baseUrl: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  const response = await fetch(`${sessionPath(baseUrl, sessionId)}/transcript`, { credentials: 'include', signal });
  if (!response.ok)
    throw new FactorySessionRequestError(`Transcript request failed (${response.status})`, response.status);
  return (await response.json()) as Transcript;
}

/**
 * Stream the session's events after `afterSeq` until `signal` aborts or the stream ends. Resolves
 * when the server closes the stream; rejects on HTTP errors, silence, or a broken connection — the
 * caller reconnects from the last `seq` it applied.
 */
export async function streamFactorySessionEvents(
  baseUrl: string,
  sessionId: string,
  afterSeq: number,
  handlers: { onEnvelope: (envelope: EventEnvelope) => void; onConnected?: () => void },
  signal: AbortSignal,
): Promise<void> {
  const silence = new AbortController();
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => silence.abort(), SILENCE_LIMIT_MS);
  };
  heard();
  const closedOrSilent = AbortSignal.any([signal, silence.signal]);
  try {
    const response = await fetch(`${sessionPath(baseUrl, sessionId)}/events?afterSeq=${afterSeq}`, {
      headers: { Accept: 'text/event-stream' },
      credentials: 'include',
      signal: closedOrSilent,
    });
    if (!response.ok || !response.body) {
      throw new FactorySessionRequestError(`Session stream failed (${response.status})`, response.status);
    }
    handlers.onConnected?.();
    const heardBytes = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        heard();
        controller.enqueue(chunk);
      },
    });
    await readSSE(response.body.pipeThrough(heardBytes, { signal: closedOrSilent }), (event, data) => {
      if (event !== 'factory') return;
      handlers.onEnvelope(JSON.parse(data) as EventEnvelope);
    });
  } finally {
    clearTimeout(silenceTimer);
  }
}
