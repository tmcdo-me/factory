import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit:factory-agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
