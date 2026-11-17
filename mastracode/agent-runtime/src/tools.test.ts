import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFactoryTool, isFactoryToolDef } from './tools';

describe('defineFactoryTool', () => {
  it('marks a definition, and a spread copy of it, but nothing else that looks like a tool', () => {
    const def = defineFactoryTool({
      name: 'factory_probe',
      description: 'Probe',
      input: z.object({}),
      execute: async () => null,
    });
    expect(isFactoryToolDef(def)).toBe(true);
    expect(isFactoryToolDef({ ...def, execute: async () => 1 })).toBe(true);
    expect(isFactoryToolDef({ name: 'x', description: 'x', input: z.object({}), execute: async () => null })).toBe(
      false,
    );
    expect(isFactoryToolDef({ id: 'x', inputSchema: z.object({}), execute: async () => null })).toBe(false);
    expect(isFactoryToolDef(undefined)).toBe(false);
  });
});
