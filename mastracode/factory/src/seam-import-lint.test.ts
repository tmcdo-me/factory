// fork(claude-agent): guards the seam import rule (mastracode/seam-import-lint.ts). oxlint's
// `no-restricted-imports` misses `require()` calls and `typeof import()` type queries and oxlint has no
// `no-restricted-syntax`, so this test scans every non-test source file for the restricted specifiers in any
// form. It also keeps the allow-lists shrinking: an entry not in the committed baseline fails, and an entry
// whose file no longer imports Mastra Code must be removed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import baseline from '../../seam-import-baseline.json';
import { factoryAllowList, factoryUiAllowList } from '../../seam-import-lint';

const RESTRICTED = /['"`]@mastra\/(?:code-sdk(?:\/[^'"`]*)?|core\/agent-controller)['"`]/;

// Factory UI is browser code: the adapter's bare root and `/sdk` are banned, only `/thinking` is allowed. Unlike
// the allow-listed specifiers above this ban has no allow-list, so any hit fails.
const FACTORY_UI_BANNED = /['"`]@factory\/runtime-mastra-code(?:\/sdk)?['"`]/;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(relative(root, path));
      }
    }
  };
  walk(join(root, 'src'));
  return out.sort();
}

const packages = [
  { name: 'factory', root: join(__dirname, '..'), allowList: factoryAllowList, baseline: baseline.factory },
  {
    name: 'factory-ui',
    root: join(__dirname, '../../factory-ui'),
    allowList: factoryUiAllowList,
    baseline: baseline.factoryUi,
  },
];

describe.each(packages)('seam import allow-list: $name', ({ root, allowList, baseline: base }) => {
  const importers = sourceFiles(root).filter(file => RESTRICTED.test(readFileSync(join(root, file), 'utf8')));

  it('only lists files from the committed baseline (it never grows)', () => {
    expect(allowList.filter(file => !base.includes(file))).toEqual([]);
  });

  it('is sorted and has no duplicates', () => {
    expect(allowList).toEqual([...new Set(allowList)].sort());
  });

  it('lists every file that imports Mastra Code in any form', () => {
    expect(importers.filter(file => !allowList.includes(file))).toEqual([]);
  });

  it('lists only files that still import Mastra Code', () => {
    expect(allowList.filter(file => !importers.includes(file))).toEqual([]);
  });
});

describe('factory-ui may import only @factory/runtime-mastra-code/thinking', () => {
  it('has no import of the adapter root or /sdk in any form', () => {
    const root = join(__dirname, '../../factory-ui');
    const offenders = sourceFiles(root).filter(file => FACTORY_UI_BANNED.test(readFileSync(join(root, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the pattern distinguishes the banned specifiers from /thinking', () => {
    expect(FACTORY_UI_BANNED.test("from '@factory/runtime-mastra-code'")).toBe(true);
    expect(FACTORY_UI_BANNED.test('import("@factory/runtime-mastra-code/sdk")')).toBe(true);
    expect(FACTORY_UI_BANNED.test("from '@factory/runtime-mastra-code/thinking'")).toBe(false);
  });
});
