// fork(claude-agent): one Factory process at a time runs Claude Agent sessions.
import type { RuntimeThreadState } from '../rules/runtime-sessions.js';

/** A holder not heard from for this long is gone, and another process may take over. */
export const CLAUDE_AGENT_HOST_STALE_MS = 30_000;

/** Where the holder is recorded: Mastra's `threadState`, under a thread id no session has. */
const HOST_KEY = { threadId: 'factory:claude-agent-host', type: 'claude-agent-host' } as const;

interface HostRecord {
  ownerId: string;
  heartbeatAt: number;
}

export interface ClaudeAgentHost {
  /** Whether this process runs Claude Agent sessions, claiming that when nobody live does. */
  held(): Promise<boolean>;
  /** Let another process take over at once (a clean shutdown). */
  release(): Promise<void>;
}

/**
 * Claude Code runs in the Factory process that opened its session, and everything Factory keeps about
 * those runs in memory (which runs are in flight, parked, approved on the board's behalf) lives there
 * too, as does the only writer of their open-run ledgers (`threadState` has no compare-and-set). So
 * one process sharing a database runs Claude Agent sessions at a time: the first to claim it, renewed
 * while it lives. Another process sharing the database refuses to open them until the holder has
 * been silent for `staleMs`, or released it.
 *
 * `ownerId` names the Factory instance, not the process (its host and Claude Agent home), so a
 * restart takes over from itself at once. Two claims made together are settled by reading back after
 * `confirmMs`: the store keeps the last write, and only its writer holds.
 */
export function claudeAgentHostLease(options: {
  store: () => Promise<RuntimeThreadState | undefined>;
  ownerId: string;
  staleMs?: number;
  confirmMs?: number;
  now?: () => number;
}): ClaudeAgentHost {
  const staleMs = options.staleMs ?? CLAUDE_AGENT_HOST_STALE_MS;
  const confirmMs = options.confirmMs ?? 1_000;
  const now = options.now ?? Date.now;
  let holding = false;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let claiming: Promise<boolean> | undefined;

  const read = async (store: RuntimeThreadState) => store.getState<HostRecord>(HOST_KEY);
  const write = (store: RuntimeThreadState, heartbeatAt: number) =>
    store.setState<HostRecord>({ ...HOST_KEY, value: { ownerId: options.ownerId, heartbeatAt } });
  const heldByAnother = (record: HostRecord | undefined) =>
    record !== undefined && record.ownerId !== options.ownerId && now() - record.heartbeatAt < staleMs;

  const stopRenewing = () => {
    clearInterval(renewal);
    renewal = undefined;
  };

  const renew = async () => {
    try {
      const store = await options.store();
      if (!store) return;
      if (heldByAnother(await read(store))) {
        holding = false;
        stopRenewing();
        console.warn(
          `[factory] another Factory process took over running Claude Agent sessions from ${options.ownerId}`,
        );
        return;
      }
      await write(store, now());
    } catch (error) {
      console.warn('[factory] renewing this process as the Claude Agent host failed:', error);
    }
  };

  const claim = async (): Promise<boolean> => {
    const store = await options.store();
    // No shared state: nothing else can share the sessions either.
    if (!store) return true;
    const current = await read(store);
    if (heldByAnother(current)) return false;
    await write(store, now());
    if (current?.ownerId !== options.ownerId) {
      await new Promise(resolve => setTimeout(resolve, confirmMs));
      if ((await read(store))?.ownerId !== options.ownerId) return false;
    }
    holding = true;
    if (!renewal) {
      renewal = setInterval(() => void renew(), Math.floor(staleMs / 3));
      renewal.unref?.();
    }
    return true;
  };

  return {
    held: async () => {
      if (holding) return true;
      claiming ??= claim().finally(() => {
        claiming = undefined;
      });
      return claiming;
    },
    release: async () => {
      stopRenewing();
      if (!holding) return;
      holding = false;
      const store = await options.store();
      if (store && (await read(store))?.ownerId === options.ownerId) await write(store, 0);
    },
  };
}
