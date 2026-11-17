import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'helpers/command.test.ts',
      'helpers/copy-artifact.test.ts',
      'helpers/inspect-manifest.test.ts',
      'tests/assertion-evidence-drift.test.ts',
      'tests/materialize-project.test.ts',
      'tests/registry-digest.test.ts',
      'tests/scenario-reporter.test.ts',
      'tests/verdaccio-resolution.test.ts',
      'vitest.config.test.ts',
    ],
  },
});
