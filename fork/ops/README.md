# Running Factory as a service

Fork-only. These files run the Factory server (`mastracode/web`) from a production build as a macOS
user LaunchAgent, deploy and roll it back, and back up its data. To run it in a container instead (the homelab's
Docker host or Fly.io, every session on a Sprite), see [`fork/deploy/`](../deploy/README.md). The defaults are mac-mini's (user
`homelab`, the `Dev` volume at `/Volumes/Dev`, Tailscale serving `https://factory.tail99d67.ts.net`
from `127.0.0.1:5873`). On mac-mini the LaunchAgents are the homelab repository's to install; this
directory is the source it installs from.

| File                           | What it is                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `factory-start.sh`             | Start script the LaunchAgent runs (installed as `~/.local/libexec/factory-start`)               |
| `homelab.factory.plist`        | LaunchAgent template for the server                                                             |
| `deploy.sh`                    | Builds a release from GitHub, switches to it, restarts the server; also `rollback` and `status` |
| `backup.sh`                    | Online snapshot of the data (installed as `~/.local/libexec/factory-backup`)                    |
| `homelab.factory-backup.plist` | LaunchAgent template running `backup.sh` daily                                                  |
| `restore.sh`                   | Puts a snapshot back, with the server stopped                                                   |

## How it runs

`pnpm --dir mastracode/web build` builds the workspace packages the server links (`prebuild`), then
bundles the server with `mastra build`. The bundle keeps the monorepo's packages external and loads
them through `mastracode/web/node_modules` (their `link:` dependencies), so the build runs only
inside its own checkout. `pnpm build:platform` is the old Mastra-platform build, which pins those
packages to npm versions; the fork's `@factory/*` packages are not on npm, so it cannot be used here.

`pnpm --dir mastracode/web start` runs the build: `varlock run` loads `.env` (checked against
`.env.schema`), then `mastra start` runs `.mastra/output/index.mjs` with `NODE_ENV=production`. Port
`PORT` (default `5873`), `MASTRACODE_PUBLIC_URL` defaulting to `http://localhost:$PORT` as in `pnpm
dev`. The UI is served by the same server from `.mastra/output/factory`.

Production differs from `pnpm dev` in what it refuses to start without. In `.env` it needs:

- `FACTORY_DATABASE=libsql` to keep the data in the local libSQL file (or `DATABASE_URL` for Postgres);
- `FACTORY_CREDENTIAL_ENCRYPTION_KEY` (or `FACTORY_CREDENTIAL_ENCRYPTION=plaintext`);
- a sandbox provider (`FACTORY_SANDBOX_PROVIDER=local` runs sessions on this machine, as today);
- for sign-in, the OIDC group and a `FACTORY_SESSION_SECRET` of 32 characters or more.

`MASTRACODE_PUBLIC_URL` must be the URL people open (`https://factory.tail99d67.ts.net`): the
sign-in callback is `<MASTRACODE_PUBLIC_URL>/auth/callback`, the GitHub App's
`<MASTRACODE_PUBLIC_URL>/auth/github/callback`.

`factory-start.sh` binds `127.0.0.1` (`FACTORY_HOST`), so only Tailscale serve reaches it, puts
`TMPDIR` on the Dev volume and turns telemetry off. Its chain, `varlock run` then `mastra start` then
the server, forwards SIGTERM and waits at each step. On SIGTERM the server stops taking requests,
drains them (5 s), stops Factory (live Claude Code processes, runs in flight end as stopped, the
Claude Agent host lease is released so the next start takes over at once, the dispatcher, Slack's
connection), then Mastra, and closes the database. A crash or a kill restarts it after 30 s; a clean
exit does not, so `launchctl kill TERM` keeps it stopped.

## Install (mac-mini)

1. Directories: `mkdir -p /Volumes/Dev/factory-app/shared ~/Library/Logs/factory ~/.local/libexec`.
2. Settings: the server's `.env` at `/Volumes/Dev/factory-app/shared/.env`, mode 600. Today's is
   `/Volumes/Dev/projects/factory/mastracode/web/.env`; add `FACTORY_DATABASE=libsql`. Keep a copy
   in the owner's vault: it is the only copy of the secrets, and nothing here backs it up.
3. Stop the hand-started `pnpm dev` (port 5873), then build and start the first release:
   `fork/ops/deploy.sh` (from any checkout; it clones its own). With no LaunchAgent loaded yet it
   builds and switches but does not start anything.
4. Scripts and LaunchAgents: copy `factory-start.sh` to `~/.local/libexec/factory-start` and
   `backup.sh` to `~/.local/libexec/factory-backup` (mode 755), the two plists to
   `~/Library/LaunchAgents/`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/homelab.factory.plist` and the same for
   `homelab.factory-backup.plist`.
5. Check: `curl -s http://127.0.0.1:5873/auth/me` answers `{"authenticated":false,…,"provider":"oidc"}`,
   and `https://factory.tail99d67.ts.net` shows the sign-in page.

The data stays where `pnpm dev` keeps it (the paths in `.env`, see [Backups](#backups)), so the
service picks up every project, board and session.

## Deploy

```sh
fork/ops/deploy.sh            # origin's main
fork/ops/deploy.sh <ref>      # a branch, tag or commit
```

A deploy builds a new release in `/Volumes/Dev/factory-app/releases/<stamp>-<sha>/` (a clone of
`repo.git`, installed and built in place, about 1 GB) while the server keeps running the old one, so a
failed build changes nothing. Then it snapshots the data (`backup.sh`), points `current` at the new
release, restarts the LaunchAgent (`launchctl kickstart -k gui/$(id -u)/homelab.factory`) and waits
up to 3 minutes for the new release to answer `/auth/me`; if it does not, it switches back and
restarts the previous one. It keeps the two newest releases (`FACTORY_KEEP_RELEASES`).

A Claude Agent run in flight when the server restarts ends as stopped, saying the server restarted,
and the session resumes its conversation on the next message.

## Logs

- `~/Library/Logs/factory/factory.log`: the server (stdout and stderr, with varlock's redaction of
  sensitive values) and the start script's lines (`factory-start: starting release …`).
- `~/Library/Logs/factory/backup.log`: the daily snapshot.
- `launchctl print gui/$(id -u)/homelab.factory`: state, pid, last exit.

Production logs at WARN. Nothing rotates the log; a restart does not either. Rotate it with a
`newsyslog` rule (needs sudo) or truncate it (`: > ~/Library/Logs/factory/factory.log`).

## Rollback

```sh
fork/ops/deploy.sh status                 # what runs, what is kept
fork/ops/deploy.sh rollback               # back to the previous release
fork/ops/deploy.sh rollback <release>     # or to a kept one by name
```

This switches code only. A release that changed the database's schema can leave data the older code
does not read; then restore the snapshot the deploy took before switching (its path is in the deploy's
output, and it is the newest snapshot from that time).

## Backups

What is kept, and why:

| Data                                                                                                                                                              | Where (mac-mini)                                                                                                             | Backed up                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database: projects, boards, work items, sessions' threads and messages, Factory's event log, Claude Agent resume state, settings, integration secrets (encrypted) | `MASTRA_DB_PATH`, else `$MASTRA_APP_DATA_DIR/mastra.db`, else `~/Library/Application Support/mastracode/mastra.db` (today's) | Yes: `sqlite3 .backup`, the online backup API, so it is consistent while the server writes; then `PRAGMA integrity_check`. Also `mastra-vectors.db` beside it, if any                                                                                                                             |
| Claude Agent home's `.claude`: the session transcripts Claude Code's `resume` reads, its settings and todos                                                       | `FACTORY_CLAUDE_AGENT_HOME` (`/Volumes/Dev/factory-data/claude-agent-home`)                                                  | Yes, without its logs, caches and login file. Without it a Claude Agent session cannot resume its conversation                                                                                                                                                                                    |
| Sandbox checkouts, one per session                                                                                                                                | `MASTRACODE_LOCAL_SANDBOX_ROOT` (`/Volumes/Dev/factory-data/sandboxes`)                                                      | No. A session's next start clones its repository again when its checkout is missing (Factory checks the disk, not its records), and work that was pushed comes back from GitHub. What is lost is work a session had not pushed. They are large (dependencies, build output) and change constantly |
| `<home>/factory-skills`, tool caches commands left in the Claude Agent home                                                                                       | Claude Agent home                                                                                                            | No: Factory writes the skills again at each session open; caches rebuild                                                                                                                                                                                                                          |
| `.env`: GitHub App key, OIDC and session secrets, credential encryption key, `CLAUDE_CODE_OAUTH_TOKEN`, Sprites token                                             | `/Volumes/Dev/factory-app/shared/.env`                                                                                       | No: it belongs in the owner's vault. Keep it current there; without `FACTORY_CREDENTIAL_ENCRYPTION_KEY` the integration secrets in a restored database cannot be read                                                                                                                             |
| Releases, `repo.git`, build cache                                                                                                                                 | `/Volumes/Dev/factory-app`                                                                                                   | No: `deploy.sh` rebuilds them from GitHub                                                                                                                                                                                                                                                         |

The same app data directory holds Mastra Code's own files (`auth.json`, `settings.json`, MCP logins);
they are not Factory's and are not backed up. If Mastra Code's CLI is used on the same machine, it
opens the same default `mastra.db`; give the server its own with `MASTRA_DB_PATH`.

`backup.sh` writes `/Volumes/Dev/factory-backups/<UTC stamp>/` (`mastra.db.gz`,
`claude-agent-home.tar.gz`, `MANIFEST` with SHA-256 sums), and deletes snapshots older than 14 days
but always keeps the newest 3. The snapshots are on the same disk as the data: they cover a bad
deploy or a broken database, not a lost machine. Copy the newest one off the machine.

## Restore

```sh
launchctl kill TERM gui/$(id -u)/homelab.factory     # stop; it stays stopped
fork/ops/restore.sh /Volumes/Dev/factory-backups/<stamp>
launchctl kickstart gui/$(id -u)/homelab.factory
```

`restore.sh` checks the snapshot against its `MANIFEST`, refuses while anything has the database open,
and moves what is there aside (`mastra.db.pre-restore-<stamp>` with its `-wal` and `-shm`, and
`.claude.pre-restore-<stamp>`) instead of deleting it. On a new machine, also put `.env` back from
the vault, then deploy. Sessions whose checkout is gone clone it again when they next start.
