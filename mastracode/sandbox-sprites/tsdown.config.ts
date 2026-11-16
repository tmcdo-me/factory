import { generateTypes } from '@internal/types-builder';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  fixedExtension: false,
  nodeProtocol: 'strip',
  clean: true,
  dts: false,
  treeshake: true,
  sourcemap: true,
  deps: {
    neverBundle: ['@factory/agent-runtime', '@fly/sprites', /^@mastra\//],
  },
  onSuccess: async () => {
    await generateTypes(process.cwd());
  },
});
