// fork(claude-agent): which source draws the chat transcript.
/**
 * `mastra` (default): the Mastra agent-controller stream and message history.
 * `factory`: Factory's runtime-neutral session event log (`/web/factory/sessions/:id/...`).
 *
 * Set at build time with `VITE_FACTORY_TRANSCRIPT_SOURCE=factory`, or per browser with
 * `localStorage.setItem('factory:transcript-source', 'factory')` (then reload). Read once per page
 * load, so a provider always calls the same hook.
 */
export type TranscriptSource = 'mastra' | 'factory';

const STORAGE_KEY = 'factory:transcript-source';

function readSource(): TranscriptSource {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === 'factory' || stored === 'mastra') return stored;
  } catch {
    // storage blocked: fall through to the build default
  }
  return import.meta.env?.VITE_FACTORY_TRANSCRIPT_SOURCE === 'factory' ? 'factory' : 'mastra';
}

export const transcriptSource: TranscriptSource = readSource();
