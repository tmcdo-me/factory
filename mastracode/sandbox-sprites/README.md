# @factory/sandbox-sprites

Fly.io Sprites as Factory's session sandbox (fork-only). Design:
[`fork/specs/claude-agent-core.md`](../../fork/specs/claude-agent-core.md) §3.5, §3.6.

| Module               | What                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `factory-sandbox.ts` | `SpritesFactorySandbox`: the host's `FactorySandbox`. Each session's sandbox is a `SessionSpritesSandbox` (a `SpritesSandbox`) named `<prefix>-<session id>` |
| `sprite-exec.ts`     | `envOverStdin`: the Sprite with every exec's environment sent over stdin; `redactSpriteError` drops the exec URL the SDK writes into its errors              |
| `sprite-process.ts`  | `spawnInSprite`: a long-lived stdio process in the Sprite, shaped like a child process / the Agent SDK's `SpawnedProcess`                                    |
| `stdin-env.ts`       | `stdinEnv`: the `sh` preamble that reads base64 values from stdin and exports them                                                                           |
| `orphans.ts`         | `listOrphanSprites`: Sprites with this prefix that no session owns (`scripts/list-orphan-sprites.mjs`)                                                       |

## How a session uses its Sprite

- **One Sprite per session**, named `<prefix>-<session id>` (prefix `FACTORY_SPRITES_PREFIX`,
  default `factory`), so a Factory restart (or another replica) finds the same VM and disk again.
  Sprites hibernate on their own when idle. Factory stops its connection when a session retires and
  deletes the Sprite when the session is deleted (its usual sandbox retirement); stopping also kills
  the long-lived processes started in it.
- **Prepare**: the host's `prepare` hook runs once the Sprite is up, before Factory's setup hook
  (clone, setup command), for what the repository must not shape (Claude Code's install).
- **Checkout**: Factory clones the session's repositories into the Sprite with its usual
  materialization (commands through `executeCommand`), under the Sprite user's home
  (`/home/sprite/<repo>`, probed with `pwd`).
- **Mastra Code** uses the sandbox's command and file API only.
- **Processes** (`SANDBOX_PROCESSES` from `@factory/agent-runtime`): runtimes that launch their own
  agent process (Claude Agent runs Claude Code inside the Sprite) get `spawn` and `files`.

## Environment and credentials

The Sprites exec API takes environment variables in the exec URL's query string, and the SDK writes
that whole URL into its WebSocket errors. So no exec in a session's Sprite sends any: the sandbox's
Sprite handle is wrapped (`envOverStdin`), and every `spawn` (Factory's commands, Mastra Code's
tools, the clone, a runtime's agent process) runs a short `sh` script instead. It reads one
base64-encoded value per line from stdin, decodes and exports it under a name fixed in the script,
and `exec`s the command, which inherits the rest of stdin. Values never appear in the URL, the
process's argv, or on the Sprite's disk, and any value (newlines included) survives. The SDK's
`exec`/`execFile`, which would put them in the URL, are refused.

Every error from an exec is rebuilt without the exec URL (`(url: …)`: the command line, `--settings`
JSON, paths), so nothing of the request reaches tool output, Factory's events or the UI.

## Configuration (web host)

| Variable                   | Meaning                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_SANDBOX_PROVIDER` | `sprites` to use this provider                                                                                          |
| `SPRITES_TOKEN`            | Sprites API token of the Fly.io organization                                                                            |
| `FACTORY_SPRITES_REGION`   | Optional region for new Sprites (e.g. `ord`)                                                                            |
| `FACTORY_SPRITES_PREFIX`   | Sprite name prefix of this deployment (default `factory`); one per deployment sharing a token, none a prefix of another |

Requires Node ≥ 24 (`@fly/sprites`).

## Orphaned Sprites

A Sprite outlives its session only if Factory crashed between deleting the session and deleting
the Sprite (or the replica that held it went away). To list them, feed the id of every row of
Factory's `source_control_sessions` table to the script; it lists only, and deletes nothing:

```sh
pnpm --filter @factory/sandbox-sprites build
SPRITES_TOKEN=… FACTORY_SPRITES_PREFIX=factory node mastracode/sandbox-sprites/scripts/list-orphan-sprites.mjs < session-ids.txt
```
