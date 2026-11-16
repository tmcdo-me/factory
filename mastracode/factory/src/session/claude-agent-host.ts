// fork(claude-agent): one Factory process at a time runs Claude Agent sessions.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { RuntimeThreadState } from '../rules/runtime-sessions.js';

/** A holder not heard from for this long is gone, and another process may take over. */
export const CLAUDE_AGENT_HOST_STALE_MS = 30_000;

/** Where the holder is recorded: Mastra's `threadState`, under a thread id no session has. */
const HOST_KEY = { threadId: 'factory:claude-agent-host', type: 'claude-agent-host' } as const;

/** Who holds the lease: one process of one Factory instance (its host and Claude Agent home). */
export interface ClaudeAgentHostIdentity {
  host: string;
  /** The Claude Agent home its sessions run in. */
  home: string;
  pid: number;
  /** Unique per boot, so a restart that reuses the pid is still a different process. */
  boot: string;
}

interface HostRecord extends ClaudeAgentHostIdentity {
  heartbeatAt: number;
}

export interface ClaudeAgentHost {
  /**
   * Whether this process runs Claude Agent sessions, claiming that when nobody live does. Read again
   * from the store each time it is asked while held, so a lease another process took is seen at once.
   */
  held(): Promise<boolean>;
  /** Told once this process stops holding the lease (another took over, or it could not renew). */
  onLost(listener: () => void): void;
  /** Let another process take over at once (a clean shutdown). */
  release(): Promise<void>;
}

/** This process, as the lease names it. */
export function claudeAgentHostIdentity(home: string): ClaudeAgentHostIdentity {
  return { host: hostname(), home, pid: process.pid, boot: randomUUID() };
}

/** Whether a process on this host is still running (`kill(pid, 0)`: EPERM means it runs as another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claude Code runs in the Factory process that opened its session, and everything Factory keeps about
 * those runs in memory (which runs are in flight, parked, approved on the board's behalf) lives there
 * too, as does the only writer of their open-run ledgers (`threadState` has no compare-and-set). So
 * one process sharing a database runs Claude Agent sessions at a time: the first to claim the lease,
 * renewed while it lives.
 *
 * Another process refuses to open them until the holder has been silent for `staleMs` or released it.
 * A holder on this host, for the same Claude Agent home, whose process is gone (a restart after a
 * crash) is taken over at once; any other waits out the stale time.
 *
 * Without compare-and-set, a claim is settled by reading the record back twice, `confirmMs` apart: the
 * store keeps the last write, and only its writer holds. A rival's write delayed past both reads could
 * still land; the holder then sees it on its next renewal or open (`held` reads the record each time)
 * and stops. A holder that cannot renew for `staleMs` stops too, since others may take over by then.
 * Either way `onLost` listeners hear it, so the sessions it ran are stopped.
 */
export function claudeAgentHostLease(options: {
  store: () => Promise<RuntimeThreadState | undefined>;
  identity: ClaudeAgentHostIdentity;
  staleMs?: number;
  confirmMs?: number;
  now?: () => number;
  /** Whether a process on this host still runs; defaults to `processAlive`. */
  alive?: (pid: number) => boolean;
}): ClaudeAgentHost {
  const me = options.identity;
  const staleMs = options.staleMs ?? CLAUDE_AGENT_HOST_STALE_MS;
  const confirmMs = options.confirmMs ?? 2_000;
  const now = options.now ?? Date.now;
  const alive = options.alive ?? processAlive;
  const listeners: (() => void)[] = [];
  let holding = false;
  let renewedAt = 0;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let claiming: Promise<boolean> | undefined;

  const mine = (record: HostRecord | undefined) => record?.boot === me.boot && record.pid === me.pid;
  const read = async (store: RuntimeThreadState) => store.getState<HostRecord>(HOST_KEY);
  const write = (store: RuntimeThreadState, heartbeatAt: number) =>
    store.setState<HostRecord>({ ...HOST_KEY, value: { ...me, heartbeatAt } });
  /** Whether `record` names another process this one must not take over from yet. */
  const heldByAnother = (record: HostRecord | undefined) => {
    if (!record || mine(record) || now() - record.heartbeatAt >= staleMs) return false;
    // This instance's own process from before a restart: gone if its pid is ours now, or not running.
    const sameInstance = record.host === me.host && record.home === me.home;
    return !(sameInstance && (record.pid === me.pid || !alive(record.pid)));
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, confirmMs));

  const stopRenewing = () => {
    clearInterval(renewal);
    renewal = undefined;
  };
  const lose = (why: string) => {
    if (!holding) return;
    holding = false;
    stopRenewing();
    console.warn(`[factory] this process (pid ${me.pid}) no longer runs Claude Agent sessions: ${why}`);
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[factory] stopping Claude Agent sessions after losing the host lease failed:', error);
      }
    }
  };

  const renew = async () => {
    try {
      const store = await options.store();
      if (!store) return;
      if (!mine(await read(store))) {
        lose('another Factory process took over');
        return;
      }
      await write(store, now());
      renewedAt = now();
    } catch (error) {
      console.warn('[factory] renewing this process as the Claude Agent host failed:', error);
      if (now() - renewedAt >= staleMs) lose(`its lease could not be renewed for ${Math.round(staleMs / 1000)}s`);
    }
  };

  const claim = async (): Promise<boolean> => {
    const store = await options.store();
    // No shared state: nothing else can share the sessions either.
    if (!store) return true;
    const current = await read(store);
    if (heldByAnother(current)) return false;
    await write(store, now());
    if (!mine(current)) {
      // Two reads apart: a rival's claim made at the same time lands between them, and only the last
      // writer holds.
      for (let check = 0; check < 2; check += 1) {
        await settle();
        if (!mine(await read(store))) return false;
      }
    }
    holding = true;
    renewedAt = now();
    if (!renewal) {
      renewal = setInterval(() => void renew(), Math.floor(staleMs / 3));
      renewal.unref?.();
    }
    return true;
  };

  return {
    held: async () => {
      if (holding) {
        const store = await options.store();
        if (!store || mine(await read(store))) return true;
        lose('another Factory process took over');
        return false;
      }
      claiming ??= claim().finally(() => {
        claiming = undefined;
      });
      return claiming;
    },
    onLost: listener => {
      listeners.push(listener);
    },
    release: async () => {
      stopRenewing();
      if (!holding) return;
      holding = false;
      const store = await options.store();
      if (store && mine(await read(store))) await write(store, 0);
    },
  };
}
