import { defineConfig } from 'oxlint';
import rootConfig from '../../oxlint.config.ts';
import { factoryAllowList, seamImportOverrides } from '../seam-import-lint.ts';

export default defineConfig({
  extends: [rootConfig],
  overrides: [
    ...(seamImportOverrides(factoryAllowList) ?? []),
    {
      // Linted without type information until now (ESLint's disableTypeChecked).
      files: ['**/*.{ts,tsx}'],
      rules: { 'typescript/no-floating-promises': 'off', 'typescript/no-misused-promises': 'off' },
    },
  ],
});
