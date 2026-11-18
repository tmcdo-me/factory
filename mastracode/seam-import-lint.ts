// fork(claude-agent): spec section 5. Factory and its UI reach agents through `@factory/agent-runtime`; they
// do not import Mastra Code's agent controller or SDK. Slice 7 emptied these lists: Factory reaches Mastra Code
// only through `@factory/runtime-mastra-code` (its `/sdk` and `/thinking` re-exports included). A new file may not be added. Test files are exempt (the adapter's tests move with it).
import { defineConfig } from 'oxlint';

export const restrictedMastraCodeImports = {
  patterns: [
    {
      group: ['@mastra/code-sdk', '@mastra/code-sdk/*', '@mastra/core/agent-controller'],
      message:
        'Use @factory/agent-runtime (spec section 5); Mastra Code internals live in @factory/runtime-mastra-code.',
    },
  ],
};

/** Files under `mastracode/factory` that still import Mastra Code's controller or SDK. */
export const factoryAllowList: string[] = [];

/** Files under `mastracode/factory-ui` that still import Mastra Code's SDK or controller types. */
export const factoryUiAllowList: string[] = [];

/** The overrides that enforce the ban outside `allowList`. */
export function seamImportOverrides(allowList: string[]): ReturnType<typeof defineConfig>['overrides'] {
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      rules: { 'no-restricted-imports': ['error', restrictedMastraCodeImports] },
    },
    { files: allowList, rules: { 'no-restricted-imports': 'off' } },
    { files: ['**/*.test.*', '**/__tests__/**'], rules: { 'no-restricted-imports': 'off' } },
  ];
}
