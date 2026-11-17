// fork(claude-agent): Factory's thinking levels (`@factory/agent-runtime`) must match Mastra Code's, which still
// resolves them per model until the adapter owns that.
import { THINKING_LEVEL_VALUES, isThinkingLevelSetting } from '@factory/agent-runtime';
import * as mastraCode from '@mastra/code-sdk/thinking';
import { describe, expect, it } from 'vitest';

describe('Factory thinking levels', () => {
  it('match the Mastra Code values', () => {
    expect(THINKING_LEVEL_VALUES).toEqual(mastraCode.THINKING_LEVEL_VALUES);
  });

  it('accept exactly the levels Mastra Code accepts', () => {
    for (const value of [...mastraCode.THINKING_LEVEL_VALUES, 'ultra', '', 1, undefined]) {
      expect(isThinkingLevelSetting(value)).toBe(mastraCode.isThinkingLevelSetting(value));
    }
  });
});
