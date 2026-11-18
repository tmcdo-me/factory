import { generateTypes } from '@internal/types-builder';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/sdk.ts', 'src/thinking.ts'],
  format: ['esm'],
  fixedExtension: false,
  nodeProtocol: 'strip',
  clean: true,
  dts: false,
  treeshake: true,
  sourcemap: true,
  deps: {
    neverBundle: ['@mastra/core', '@mastra/server', '@mastra/code-sdk', '@factory/agent-runtime'],
  },
  onSuccess: async () => {
    await generateTypes(process.cwd());
  },
});
