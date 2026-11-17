import { describe, expect, it } from 'vitest';
import { THINKING_LEVEL_VALUES, isThinkingLevelSetting } from './thinking';

describe('thinking levels', () => {
  it('lists the levels lowest first', () => {
    expect(THINKING_LEVEL_VALUES).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('accepts only listed levels', () => {
    expect(isThinkingLevelSetting('xhigh')).toBe(true);
    expect(isThinkingLevelSetting('ultra')).toBe(false);
    expect(isThinkingLevelSetting(undefined)).toBe(false);
  });
});
