// fork(claude-agent)
import { describe, expect, it } from 'vitest';

import { draftRuntimeChoice } from '../useSessionRuntime';

describe('draftRuntimeChoice', () => {
  it('uses the project default until the composer picks, and gives Claude Agent a model', () => {
    expect(draftRuntimeChoice('draft-a', undefined)).toEqual({ runtimeId: 'mastra-code' });
    expect(draftRuntimeChoice('draft-a', 'claude-agent')).toEqual({
      runtimeId: 'claude-agent',
      modelId: 'claude-opus-5-5',
    });
  });
});
