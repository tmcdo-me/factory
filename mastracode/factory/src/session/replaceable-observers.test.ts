import { InMemoryEventLog, SessionEventHub } from '@factory/agent-runtime';
import { describe, expect, it } from 'vitest';

import { createReplaceableObservers } from './replaceable-observers.js';

describe('createReplaceableObservers', () => {
  it('leaves one set of observers per session id when a session is created again', async () => {
    const hub = new SessionEventHub(new InMemoryEventLog());
    const observers = createReplaceableObservers();
    const ends: string[] = [];
    const attach = (label: string) =>
      observers.replace('s', [
        hub.listen('s', ({ event }) => {
          if (event.type === 'run.ended') ends.push(label);
        }),
      ]);
    attach('first');
    attach('recreated');
    await hub.publish('s', { type: 'run.ended', runId: 'r1', reason: 'complete' });
    expect(ends).toEqual(['recreated']);

    observers.release('s');
    await hub.publish('s', { type: 'run.ended', runId: 'r2', reason: 'complete' });
    expect(ends).toEqual(['recreated']);
  });
});
