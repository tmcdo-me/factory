import { describe, expect, it } from 'vitest';

import { SANDBOX_PROCESSES, sandboxProcessesOf } from './workspace';
import type { SandboxProcesses } from './workspace';

describe('sandboxProcessesOf', () => {
  it("finds a sandbox's processes by the shared key, and nothing on a sandbox without them", () => {
    const processes = { kind: 'sprite' } as SandboxProcesses;
    expect(sandboxProcessesOf({ [Symbol.for('factory.sandbox.processes')]: processes })).toBe(processes);
    expect(sandboxProcessesOf({ [SANDBOX_PROCESSES]: processes })).toBe(processes);
    expect(sandboxProcessesOf({ provider: 'local' })).toBeUndefined();
    expect(sandboxProcessesOf(undefined)).toBeUndefined();
    expect(sandboxProcessesOf('sandbox')).toBeUndefined();
  });
});
