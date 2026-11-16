# tmcdo-me/factory

A fork of [`mastra-ai/mastra`](https://github.com/mastra-ai/mastra), kept to run a self-hosted
Mastra Factory with an additional, selectable **Claude Agent** core (Claude Agent SDK, running the
unmodified Claude Code binary).

## Remotes

| Remote     | URL                                    | Use                          |
| ---------- | -------------------------------------- | ---------------------------- |
| `origin`   | `github.com/tmcdo-me/factory`          | our branches                 |
| `upstream` | `github.com/mastra-ai/mastra`          | fetch only (push disabled)   |

`main` mirrors `upstream/main` and is never committed to directly:

```sh
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
```

## Relationship to upstream

We are replacing Factory's hard-wired Mastra Code agent with a Factory-owned agent runtime seam
(Mastra Code and Claude Agent as adapters). See
[`fork/specs/claude-agent-core.md`](fork/specs/claude-agent-core.md).

- **Until the seam carries the UI and session API**, feature branches rebase onto `main`.
- **After that, we stop rebasing.** Upstream changes are reviewed and cherry-picked, or
  re-implemented, when we want them. Cheapest to take: non-chat UI, integrations, board
  definitions, storage domains. Expect conflicts in Factory's server core (`factory.ts`,
  dispatcher, workspace, session/tool wiring).
- Fork-only code lives in new paths (`fork/`, `mastracode/agent-runtime`,
  `mastracode/runtime-*`) so upstream never touches it.
- Specs and decisions: [`fork/specs/`](fork/specs/).
