// fork(claude-agent): the operator's cap on how many Claude Agent turns run at once (spec slice 13).
import { ClaudeTurnLimiter } from '@factory/runtime-claude-agent';

/** The setting's key in the agent-sessions domain's runtime settings. */
export const CLAUDE_AGENT_MAX_CONCURRENT_SETTING = 'claude-agent.maxConcurrent';

/** The highest cap the setting takes. */
export const CLAUDE_AGENT_MAX_CONCURRENT_LIMIT = 64;

/** How often the process that runs Claude Agent sessions reads the setting again (another process may change it). */
const REREAD_MS = 15_000;

/**
 * The deployment's default cap: `FACTORY_CLAUDE_AGENT_MAX_CONCURRENT`, a whole number; unset, `0` or
 * anything else is no limit.
 */
export function claudeAgentMaxConcurrentDefault(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.FACTORY_CLAUDE_AGENT_MAX_CONCURRENT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}

/** Where the setting is kept (the agent-sessions domain). */
export interface ClaudeAgentConcurrencySettings {
  getSetting<T = unknown>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
}

/** What the setting says, and what is in force. */
export interface ClaudeAgentConcurrencyState {
  /** What Settings set: a cap, `0` for no limit, or `null` to follow the server's default. */
  maxConcurrent: number | null;
  /** The server's default (`FACTORY_CLAUDE_AGENT_MAX_CONCURRENT`), `null` when it sets no limit. */
  defaultMaxConcurrent: number | null;
  /** The cap in force, `null` for no limit. */
  effective: number | null;
  /** Claude Agent sessions running a turn in this process now, and those waiting for a slot. */
  running: number;
  waiting: number;
}

/**
 * The cap Claude Agent sessions run under: the setting when there is one, else the server's default.
 * The limiter reads it synchronously, so the setting is kept in memory: read at start, again every
 * 15 seconds (a change made through another process sharing the database reaches this one), and at
 * once when it is changed here. A change applies to the next turn to start and lets in whoever
 * waits and now fits; turns already running are never stopped.
 */
export class ClaudeAgentConcurrency {
  readonly limiter: ClaudeTurnLimiter;
  readonly #settings: ClaudeAgentConcurrencySettings | undefined;
  readonly #default: number | undefined;
  #setting: number | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    settings?: ClaudeAgentConcurrencySettings;
    env?: Record<string, string | undefined>;
    onChanged?(sessionId: string): void;
  }) {
    this.#settings = options.settings;
    this.#default = claudeAgentMaxConcurrentDefault(options.env);
    this.limiter = new ClaudeTurnLimiter({
      cap: () => (this.#setting === null ? this.#default : this.#setting),
      ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    });
  }

  /** Read the setting now, and keep reading it. */
  async start(): Promise<void> {
    await this.reload();
    this.#timer ??= setInterval(() => void this.reload(), REREAD_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Read the setting again; a failed read keeps the last one. */
  async reload(): Promise<void> {
    if (!this.#settings) return;
    try {
      this.#apply(await this.#settings.getSetting<unknown>(CLAUDE_AGENT_MAX_CONCURRENT_SETTING));
    } catch (error) {
      console.warn('[factory] Reading the Claude Agent concurrency setting failed; keeping the last one.', error);
    }
  }

  /** Change the setting (`null`: follow the server's default). Applies at once. */
  async set(maxConcurrent: number | null): Promise<void> {
    if (!this.#settings) throw new Error('Runtime settings are not stored on this server.');
    await this.#settings.setSetting(CLAUDE_AGENT_MAX_CONCURRENT_SETTING, maxConcurrent);
    this.#apply(maxConcurrent);
  }

  state(): ClaudeAgentConcurrencyState {
    const snapshot = this.limiter.snapshot();
    return {
      maxConcurrent: this.#setting,
      defaultMaxConcurrent: this.#default ?? null,
      effective: snapshot.cap ?? null,
      running: snapshot.running,
      waiting: snapshot.waiting.length,
    };
  }

  #apply(value: unknown): void {
    const next =
      typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? Math.min(value, CLAUDE_AGENT_MAX_CONCURRENT_LIMIT)
        : null;
    if (next === this.#setting) return;
    this.#setting = next;
    this.limiter.update();
  }
}
