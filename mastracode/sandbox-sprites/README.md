# @factory/sandbox-sprites

Fly.io Sprites as Factory's session sandbox (fork-only). Design:
[`fork/specs/claude-agent-core.md`](../../fork/specs/claude-agent-core.md) §3.5, §3.6.

| Module               | What                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory-sandbox.ts` | `SpritesFactorySandbox`: the host's `FactorySandbox`. Each session's sandbox is a `SpritesSandbox` (`@mastra/sprites`) named `factory-<session id>`, created on first start |
| `sprite-process.ts`  | `spawnInSprite`: a long-lived stdio process in the Sprite (`sprite.spawn`, a WebSocket exec), shaped like a child process / the Agent SDK's `SpawnedProcess`                |
| `stdin-env.ts`       | `stdinEnv`: a process's environment goes over its stdin, never in the exec URL                                                                                              |

## How a session uses its Sprite

- **One Sprite per session**, named from the session id, so a Factory restart (or another replica)
  finds the same VM and disk again. Sprites hibernate on their own when idle. Factory stops its
  connection when a session retires and deletes the Sprite when the session is deleted (its usual
  sandbox retirement).
- **Checkout**: Factory clones the session's repositories into the Sprite with its usual
  materialization (commands through `executeCommand`), under the Sprite user's home
  (`/home/sprite/<repo>`, probed with `pwd`).
- **Mastra Code** uses the sandbox's command and file API only.
- **Processes** (`SANDBOX_PROCESSES` from `@factory/agent-runtime`): runtimes that launch their own
  agent process (Claude Agent runs Claude Code inside the Sprite) get `spawn` and `files`.

## Environment and credentials

The Sprites exec API takes environment variables in the exec URL's query string. A process
started with `spawnInSprite` gets none there: the exec runs a short `sh` script that reads one
value per line from stdin, exports it under a name fixed in the script, and `exec`s the command,
which inherits the rest of stdin. Values never appear in the URL, the process's argv, or on the
Sprite's disk. Commands run through `executeCommand` (Mastra Code's tools, the clone) still pass the
sandbox env in the exec URL, as `@mastra/sprites` does.

## Configuration (web host)

| Variable                   | Meaning                                      |
| -------------------------- | -------------------------------------------- |
| `FACTORY_SANDBOX_PROVIDER` | `sprites` to use this provider               |
| `SPRITES_TOKEN`            | Sprites API token of the Fly.io organization |
| `FACTORY_SPRITES_REGION`   | Optional region for new Sprites (e.g. `ord`) |

Requires Node ≥ 24 (`@fly/sprites`).
