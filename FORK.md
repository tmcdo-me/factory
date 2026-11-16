# tmcdo-me/factory

A fork of [`mastra-ai/mastra`](https://github.com/mastra-ai/mastra), kept to run a self-hosted
Mastra Factory with an additional, selectable **Claude Agent** core (Claude Agent SDK, running the
unmodified Claude Code binary).

## Remotes

| Remote     | URL                           | Use                        |
| ---------- | ----------------------------- | -------------------------- |
| `origin`   | `github.com/tmcdo-me/factory` | our branches               |
| `upstream` | `github.com/mastra-ai/mastra` | fetch only (push disabled) |

`main` is **our trunk**. Work lands on it through pull requests on `tmcdo-me/factory`, one per
slice (`gh pr create --repo tmcdo-me/factory --base main` — `gh` defaults to the upstream parent
for forks, and nothing is ever opened against `mastra-ai/mastra`).

Taking upstream changes is its own PR:

```sh
git fetch upstream
git switch -c sync/upstream-$(date +%F) main
git merge upstream/main        # or cherry-pick specific commits
gh pr create --repo tmcdo-me/factory --base main
```

## CI

Upstream's workflows are disabled on the fork; `.github/workflows/fork-ci.yml` is ours. After an
upstream sync, disable any newly added upstream workflow that isn't guarded by
`github.repository == 'mastra-ai/mastra'`.

## Relationship to upstream

We are replacing Factory's hard-wired Mastra Code agent with a Factory-owned agent runtime seam
(Mastra Code and Claude Agent as adapters). See
[`fork/specs/claude-agent-core.md`](fork/specs/claude-agent-core.md).

- **Until the seam carries the UI and session API**, upstream merges should be cheap.
- **After that, expect conflicts.** Upstream changes are reviewed and merged, cherry-picked, or
  re-implemented, when we want them. Cheapest to take: non-chat UI, integrations, board
  definitions, storage domains. Expect conflicts in Factory's server core (`factory.ts`,
  dispatcher, workspace, session/tool wiring).
- Fork-only code lives in new paths (`fork/`, `mastracode/agent-runtime`,
  `mastracode/runtime-*`) so upstream never touches it.
- Specs and decisions: [`fork/specs/`](fork/specs/).
