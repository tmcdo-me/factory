// fork(claude-agent): the context windows an OpenAI-compatible provider reports for its models.

/** How long a save waits for the provider's model list before going on without it. */
const MODELS_TIMEOUT_MS = 5_000;

/** The largest window taken as real (10M tokens); anything past it is a misread field. */
const MAX_CONTEXT_WINDOW = 10_000_000;

/** A positive whole token count no larger than any real window, else nothing. */
export function contextWindowValue(value: unknown): number | undefined {
  const tokens = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0 && tokens <= MAX_CONTEXT_WINDOW
    ? tokens
    : undefined;
}

function field(entry: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = entry;
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Where OpenAI-compatible servers put a model's context window in `/v1/models`, most specific
 * first: OpenRouter and LiteLLM-style `context_length`/`context_window`/`max_input_tokens`, vLLM's
 * `max_model_len`, LM Studio's `max_context_length`, OpenRouter's `top_provider`, models.dev's
 * `limit.context`, and llama.cpp's serving `meta.n_ctx` (never `n_ctx_train`, the model's training
 * length, which the server may not serve).
 */
const WINDOW_FIELDS: readonly string[][] = [
  ['context_window'],
  ['context_length'],
  ['contextWindow'],
  ['contextLength'],
  ['max_context_length'],
  ['max_context_window'],
  ['max_model_len'],
  ['max_input_tokens'],
  ['input_token_limit'],
  ['inputTokenLimit'],
  ['top_provider', 'context_length'],
  ['limit', 'context'],
  ['meta', 'n_ctx'],
];

/** The context window each listed model reports in a `/v1/models` body (`{ data: [...] }` or a bare array). */
export function contextWindowsFromModelList(body: unknown): Record<string, number> {
  const entries = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  const windows: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (!id) continue;
    for (const path of WINDOW_FIELDS) {
      const tokens = contextWindowValue(field(record, path));
      if (tokens !== undefined) {
        windows[id] = tokens;
        break;
      }
    }
  }
  return windows;
}

/**
 * Ask the provider for its models and read the context windows it reports for `models`. Best
 * effort: a provider that can't be reached in time, refuses, or reports none gives no windows, and
 * the save goes on. The key goes only to the provider's own URL, as model calls send it.
 */
export async function readProviderContextWindows({
  url,
  apiKey,
  models,
  fetch: fetchImpl = fetch,
  timeoutMs = MODELS_TIMEOUT_MS,
}: {
  url: string;
  apiKey?: string;
  models: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<Record<string, number>> {
  if (models.length === 0) return {};
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/models`, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) return {};
    const reported = contextWindowsFromModelList(await response.json());
    return Object.fromEntries(models.flatMap(model => (reported[model] ? [[model, reported[model]]] : [])));
  } catch {
    return {};
  }
}
