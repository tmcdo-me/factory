// fork(claude-agent)
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeThreadState } from '../rules/runtime-sessions.js';
import { claudeAgentHostLease, processAlive } from './claude-agent-host.js';
import type { ClaudeAgentHostIdentity } from './claude-agent-host.js';

function memory(): RuntimeThreadState & { failing: boolean; raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  const store = {
    failing: false,
    raw,
    getState: async <T>({ threadId, type }: { threadId: string; type: string }) => {
      if (store.failing) throw new Error('database unavailable');
      return structuredClone(raw.get(`${threadId} ${type}`)) as T | undefined;
    },
    setState: async ({ threadId, type, value }: { threadId: string; type: string; value: unknown }) => {
      if (store.failing) throw new Error('database unavailable');
      raw.set(`${threadId} ${type}`, structuredClone(value));
    },
  };
  return store;
}

const identity = (overrides: Partial<ClaudeAgentHostIdentity> = {}): ClaudeAgentHostIdentity => ({
  host: 'mac-1',
  home: '/home/u/.mastracode/web/claude-agent-home',
  pid: 100,
  boot: `boot-${overrides.pid ?? 100}`,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('claudeAgentHostLease', () => {
  const lease = (
    store: RuntimeThreadState,
    who: ClaudeAgentHostIdentity,
    clock: { now: number },
    alive: (pid: number) => boolean = () => true,
  ) =>
    claudeAgentHostLease({
      store: async () => store,
      identity: who,
      staleMs: 1_000,
      confirmMs: 1,
      now: () => clock.now,
      alive,
    });

  it('lets one of two live processes on one host, sharing a database and home, run the sessions', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    // The live server, and a worktree's dev server beside it.
    expect(await lease(store, identity({ pid: 100 }), clock).held()).toBe(true);
    expect(await lease(store, identity({ pid: 200 }), clock).held()).toBe(false);
  });

  it("takes over at once from this instance's process that died, and otherwise only once the holder is stale", async () => {
    const store = memory();
    const clock = { now: 10_000 };
    expect(await lease(store, identity({ pid: 100 }), clock).held()).toBe(true);

    // A crash, then a restart under a new pid: the old pid is gone, so no stale wait.
    expect(await lease(store, identity({ pid: 300 }), clock, pid => pid !== 100).held()).toBe(true);
    // A restart that got the same pid (a container's pid 1) is a new boot, and takes over too.
    expect(await lease(store, identity({ pid: 300, boot: 'boot-again' }), clock).held()).toBe(true);

    // Another host can't tell whether the holder lives: it waits out the stale time.
    const elsewhere = lease(store, identity({ host: 'mac-2', pid: 400 }), clock, () => false);
    expect(await elsewhere.held()).toBe(false);
    clock.now += 1_500;
    expect(await elsewhere.held()).toBe(true);
  });

  it('lets another process take over at once after a release', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    const first = lease(store, identity({ pid: 100 }), clock);
    expect(await first.held()).toBe(true);
    await first.release();
    expect(await lease(store, identity({ host: 'mac-2', pid: 200 }), clock).held()).toBe(true);
  });

  it('settles two claims made together on one holder', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    const [a, b] = await Promise.all([
      lease(store, identity({ pid: 100 }), clock).held(),
      lease(store, identity({ host: 'mac-2', pid: 200 }), clock).held(),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('stops holding, and says so, once another process took it over', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    const holder = lease(store, identity({ pid: 100 }), clock);
    const lost = vi.fn();
    holder.onLost(lost);
    expect(await holder.held()).toBe(true);

    // A rival's claim that landed after both read-backs (a slow store): the next open sees it.
    store.raw.set('factory:claude-agent-host claude-agent-host', {
      ...identity({ host: 'mac-2', pid: 200 }),
      heartbeatAt: clock.now,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await holder.held()).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('stops holding once it could not renew for the stale time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'Date'], now: 10_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = memory();
    const holder = claudeAgentHostLease({ store: async () => store, identity: identity(), staleMs: 900, confirmMs: 1 });
    const lost = vi.fn();
    holder.onLost(lost);
    const claimed = holder.held();
    await vi.advanceTimersByTimeAsync(5);
    expect(await claimed).toBe(true);

    store.failing = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(lost).not.toHaveBeenCalled(); // a failed renewal or two is not yet a lost lease
    await vi.advanceTimersByTimeAsync(600);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be renewed'));
  });

  it('holds without a shared store: nothing else can share the sessions', async () => {
    const host = claudeAgentHostLease({ store: async () => undefined, identity: identity() });
    expect(await host.held()).toBe(true);
  });

  it('tells a running process from a gone one', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12_345)).toBe(false);
  });
});
