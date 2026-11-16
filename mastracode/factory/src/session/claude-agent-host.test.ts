// fork(claude-agent)
import { describe, expect, it } from 'vitest';

import type { RuntimeThreadState } from '../rules/runtime-sessions.js';
import { claudeAgentHostLease } from './claude-agent-host.js';

function memory(): RuntimeThreadState {
  const values = new Map<string, unknown>();
  return {
    getState: async <T>({ threadId, type }: { threadId: string; type: string }) =>
      structuredClone(values.get(`${threadId} ${type}`)) as T | undefined,
    setState: async ({ threadId, type, value }) => {
      values.set(`${threadId} ${type}`, structuredClone(value));
    },
  };
}

describe('claudeAgentHostLease', () => {
  const lease = (store: RuntimeThreadState, ownerId: string, clock: { now: number }) =>
    claudeAgentHostLease({ store: async () => store, ownerId, staleMs: 1_000, confirmMs: 5, now: () => clock.now });

  it('lets one process run Claude Agent sessions, and another only once the first is gone or let go', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    const first = lease(store, 'host-a', clock);
    const second = lease(store, 'host-b', clock);

    expect(await first.held()).toBe(true);
    expect(await second.held()).toBe(false);

    // Silent past the stale time (a crash): the other process takes over.
    clock.now += 1_500;
    expect(await second.held()).toBe(true);
    await second.release();

    // Let go (a clean shutdown): taken at once.
    const third = lease(store, 'host-c', clock);
    expect(await third.held()).toBe(true);
    await third.release();
  });

  it('takes over from itself at once after a restart', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    expect(await lease(store, 'host-a', clock).held()).toBe(true);
    // The old process never released (killed); the same instance starts again.
    expect(await lease(store, 'host-a', clock).held()).toBe(true);
  });

  it('settles two claims made together on one holder', async () => {
    const store = memory();
    const clock = { now: 10_000 };
    const [a, b] = await Promise.all([lease(store, 'host-a', clock).held(), lease(store, 'host-b', clock).held()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('holds without a shared store: nothing else can share the sessions', async () => {
    const host = claudeAgentHostLease({ store: async () => undefined, ownerId: 'host-a' });
    expect(await host.held()).toBe(true);
  });
});
