import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

// fork(claude-agent): tests that boot the real entry (`import('./index.js')`) open the app's
// libSQL database at `getAppDataDir()`. Without this they would open the operator's real
// `~/Library/Application Support/mastracode/mastra.db` (the live server's) and run storage init
// against it. Give every run a throwaway data directory unless the caller chose one.
const appDataDir = process.env.MASTRA_APP_DATA_DIR || mkdtempSync(join(tmpdir(), 'mastracode-web-test-'));
const env = { MASTRA_APP_DATA_DIR: appDataDir };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit:mastracode-web',
          environment: 'node',
          env,
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          // Scenarios drive a real in-process controller server + AIMock; they
          // need network + node builtins, so run in the node environment.
          name: 'e2e:mastracode-web',
          environment: 'node',
          env,
          include: ['e2e/web/**/*.scenario.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Run test files sequentially — each scenario starts its own AIMock
          // + AgentController + Hono server, and concurrent runs can cause
          // port/state collisions in the shared process.
          fileParallelism: false,
        },
      },
    ],
  },
});
