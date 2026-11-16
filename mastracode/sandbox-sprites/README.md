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
  agent process get `spawn` and `files`.
- **Claude Agent** runs Claude Code inside the Sprite. The web host's `prepare` installs it with
  Anthropic's installer before Factory's setup runs, pinned to the Agent SDK's bundled CLI version
  and verified against that release's SHA-256, in `~/.factory/claude-agent` (its home: config,
  transcripts, Factory's skills plugin). Every Claude Agent open verifies it again (installing it
  if it is missing or changed), and every launch checks the checksum once more before `exec`ing it.
  Factory's MCP server stays in Factory; its traffic rides Claude Code's stdio. See
  `@factory/runtime-claude-agent` ("In a sandbox").

## Environment and credentials

The Sprites exec API takes environment variables in the exec URL's query string, and the SDK writes
that whole URL into its WebSocket errors. So no exec in a session's Sprite sends any: the sandbox's
Sprite handle is wrapped (`envOverStdin`), and every `spawn` (Factory's commands, Mastra Code's
tools, the clone, a runtime's agent process) runs a short `sh` script instead. It reads one
base64-encoded value per line from stdin, decodes and exports it under a name fixed in the script,
and `exec`s the command, which inherits the rest of stdin. Values never appear in the URL, the
process's argv, or on the Sprite's disk, and any value (newlines included) survives. Only the
system's own `base64` (`/usr/bin`, else `/bin`) decodes them, with PATH pinned to those directories
while the preamble runs, so a `base64` planted on PATH never reads them; the command gets the PATH
the exec had. `sh` itself is `/bin/sh`. Of the Sprite's other methods only those that start no
process and take no environment pass through (filesystem, checkpoints, delete); `exec`,
`execFile`, `execFileHTTP`, `createSession`, `attachSession`, `createService` and the rest are
refused.

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

## Tests

```sh
pnpm --filter @factory/sandbox-sprites test   # fakes only: a fake Sprite exec that speaks stdio
# the real Claude Code binary (the SDK's bundled one) through the fake Sprite exec; no Fly, no login:
FACTORY_SPRITES_E2E=1 pnpm --filter @factory/sandbox-sprites exec vitest run src/claude-code.e2e.test.ts
```

## Live check

`sprites.live.test.ts` passed against a real Sprite (Ubuntu 26.04, 2026-11-16), with the turn,
the resume and the Bash-sandbox probe; the full Factory flow below has not been checked yet. What
it needs:

1. **In Fly.io:** an organization with Sprites enabled ([sprites.dev](https://sprites.dev)), and a
   Sprites API token for it. The token selects the organization; Sprites are created there as
   `<prefix>-<session id>` (and `factorylivecheck-*` by the live test).
2. **On the Factory host:** Node ≥ 24, and in its environment:
   - `FACTORY_SANDBOX_PROVIDER=sprites`, `SPRITES_TOKEN=<token>`, optionally `FACTORY_SPRITES_REGION`
     and `FACTORY_SPRITES_PREFIX` (required in practice when another deployment shares the token);
   - `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (Claude Agent sessions; passed to the
     binary in the Sprite over the exec's stdin, never stored);
   - optionally `FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS` (default 10 minutes; `0` keeps an idle Claude
     Code running);
   - the GitHub App as usual, so Factory can clone into the Sprite.
3. **In the Sprite's image** (the Sprites default has these): `sh`, `bash`, `curl`, `git`,
   `base64` and `sha256sum` (coreutils), `readlink -f`, `setpriv` (util-linux); outbound HTTPS to
   `claude.ai` and `downloads.claude.ai` (installer and release), `api.anthropic.com` and
   `github.com`; an ordinary (non-root) user with passwordless `sudo` and `apt-get`, which install
   bubblewrap and socat for Claude Code's Bash sandbox (not in the default image).

Then:

```sh
# install (in prepare, before any setup), checksum, env over stdin, MCP + skills in the Sprite
# (no turn; deletes its Sprite afterwards):
FACTORY_SPRITES_LIVE=1 SPRITES_TOKEN=… pnpm --filter @factory/sandbox-sprites exec vitest run src/sprites.live.test.ts
# plus one turn and a resume in a new Claude Code process, and one turn in Claude Code's Bash
# sandbox whose probe checks that its commands can't get at Claude's token while git, gh, npm and
# the network still work (a few cents):
FACTORY_SPRITES_LIVE=1 FACTORY_SPRITES_LIVE_TURN=1 SPRITES_TOKEN=… CLAUDE_CODE_OAUTH_TOKEN=… pnpm --filter @factory/sandbox-sprites exec vitest run src/sprites.live.test.ts
```

And in Factory: a project whose default runtime is Claude Agent, a session on it, one message.
Check that the Sprite `<prefix>-<session id>` exists with the checkout in `/home/sprite/<repo>`,
that the turn completes, that a restart of Factory resumes the conversation, that an idle session
lets its Sprite hibernate, and that deleting the session deletes the Sprite.

What only a live Sprite can show:

- **The installed binary's checksum.** The release manifest on downloads.claude.ai and the SDK's
  `manifest.json` carry the same SHA-256 for every 2.1.325 build (checked), and the installer
  verifies its download against it; `claude install` leaves that same file in
  `~/.local/share/claude/versions/` (confirmed live). If it ever does not, the install fails
  closed, saying the binary does not match its published checksum.
- **The user.** Claude Code refuses `bypassPermissions` as root (`bypass_root`); the live test
  checks `id -u`.
- **The preamble.** If Claude Code exits as soon as it starts, reporting a malformed first message,
  the Sprite's `sh` read past the environment preamble (see `stdin-env.ts`).
- **Root ownership.** The install makes the binary read-only, and root-owned where `sudo -n`
  works. A session user with `sudo` can undo both; the checksum at every launch is the check that
  holds.
- **Claude Code's Bash sandbox** (on by default, spec §6 9c). The Sprite's user holds a container's
  default capabilities as ambient ones, which bubblewrap refuses to run with, so the launch drops
  them (`setpriv`) before `exec`ing Claude Code; and the container masks parts of `/proc`
  (`/proc/kcore`, `/proc/keys`, `/proc/timer_list`, `/proc/scsi`), which stops bubblewrap from
  mounting the fresh `/proc` that hides Claude Code's process (and the token in its environment)
  from commands, so the launch unmounts those masks with `sudo` (again after a restart; the Sprite
  is a VM of its own). `enableWeakerNestedSandbox` (bind-mounting the container's `/proc`) is not
  used: it would show commands Claude Code's `/proc/<pid>/environ`. A launch whose trial sandbox
  fails refuses to start (exit 97). Commands run with no capabilities and `no_new_privs`, so
  `sudo` (and `sudo apt-get install`) doesn't work inside the sandbox.
