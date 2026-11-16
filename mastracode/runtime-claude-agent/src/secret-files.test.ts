import { describe, expect, it } from 'vitest';

import { claudeAgentFileToolDeny, claudeAgentSecretFiles } from './secret-files';

describe('claudeAgentFileToolDeny', () => {
  it('names each file as Claude Code reads a rule: `//` absolute, `~/` from its home', () => {
    expect(claudeAgentFileToolDeny(claudeAgentSecretFiles(['/srv/factory/.env', '/srv/factory/.env']))).toEqual([
      'Read(~/.claude/.credentials.json)',
      'Edit(~/.claude/.credentials.json)',
      'Read(//srv/factory/.env)',
      'Edit(//srv/factory/.env)',
    ]);
  });

  // `--disallowedTools` is one comma-separated list split outside parentheses, and a rule's content is a
  // gitignore-style pattern: a path with `(`, `)`, `*` or `[` must neither end the rule early nor widen
  // into a glob that misses the file.
  it('keeps an odd path from breaking the rule list or turning into a glob', () => {
    const rules = claudeAgentFileToolDeny(['/Users/me/Factory (old), copy/.env', '/srv/[x]/*.env']);
    expect(rules).toEqual([
      'Read(//Users/me/Factory ?old?, copy/.env)',
      'Edit(//Users/me/Factory ?old?, copy/.env)',
      'Read(//srv/?x?/?.env)',
      'Edit(//srv/?x?/?.env)',
    ]);
    for (const rule of rules) expect(rule.slice(rule.indexOf('(') + 1, -1)).not.toMatch(/[()]/);
  });

  it('skips relative paths, and adds /proc only for Linux', () => {
    expect(claudeAgentFileToolDeny(['relative/.env', ' '])).toEqual([]);
    expect(claudeAgentFileToolDeny([], { linux: true })).toEqual([
      'Read(//proc)',
      'Edit(//proc)',
      'Read(//proc/**)',
      'Edit(//proc/**)',
    ]);
  });
});
