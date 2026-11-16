# Running Factory in a container

Fork-only. These files run the Factory server (`mastracode/web`) as a container: on the homelab's
Docker host as a Compose stack (the primary place), or on one Fly.io Machine (an option, untested). Every
session runs on its own Fly.io Sprite (`@factory/sandbox-sprites`); the server itself keeps only the
UI, the API and one libSQL file. `fork/ops/` is the same server as a LaunchAgent on mac-mini.

| File                       | What it is                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `Dockerfile`               | The image. Build context: the repository root                                             |
| `Dockerfile.dockerignore`  | Keeps the context to sources (no `node_modules`, build output, `.git`, `.env`, databases) |
| `stage-runtime.mjs`        | Build step: hard-links what the server loads into `/app`, so the image has no build tools |
| `factory-entrypoint.sh`    | Gives a fresh `/data` to `node`, then runs tini and the command as node                   |
| `factory-snapshot.sh`      | Online, checked copy of the database onto the volume (`/usr/local/bin/factory-snapshot`)  |
| `factory-sqlite-check.mjs` | `integrity_check` through libSQL, for a schema stock SQLite cannot parse (vector indexes) |
| `factory-healthcheck.mjs`  | The image's health check, `GET /auth/me` (`/usr/local/bin/factory-healthcheck`)           |
| `smoke.sh`                 | End-to-end check of a built image, with a throwaway volume and env                        |
| `compose.yaml`             | Compose stack in the homelab repository's conventions, with the snapshot sidecar          |
| `compose.env.example`      | Its `.env.example`: `op://` references, no values                                         |
| `fly.toml`                 | One Fly Machine with a volume                                                             |

## The image

`.github/workflows/fork-image.yml` (`Fork image`) builds it on a Blacksmith runner (linux/amd64, the
Docker VM is x86) with Blacksmith's layer cache, runs `smoke.sh` against it, and on `main` pushes it
to `ghcr.io/tmcdo-me/factory`, tagged with the full commit SHA and `main`, with OCI labels, provenance
and an SBOM. Pull requests that touch `fork/deploy/`, the workflow, `mastracode/web/` or the lockfiles
build and check it without pushing. By hand:

```sh
docker build -f fork/deploy/Dockerfile -t factory:dev .     # from the repository root; ~10 GB free
fork/deploy/smoke.sh factory:dev
```

The GHCR package is private when the workflow first creates it. The repository is public, so making
the package public (its settings on GitHub, the owner's call) lets the Docker VM pull it with no
credential; otherwise the VM needs `docker login ghcr.io` with a token that can read packages.

The build stage installs only the workspace packages the server links and their dependencies (the
filter of `mastracode/web`'s `prebuild`, about 70 of the monorepo's 200 projects), runs the same
steps as `pnpm --dir mastracode/web build` in `fork/ops/deploy.sh` (its `prebuild`, then `mastra build`
through node, since a fresh install has no `mastra` bin until the CLI is built), then `stage-runtime.mjs` walks the bundle's
imports through `node_modules` (dependencies, optional and peer dependencies, never dev dependencies)
and hard-links each package it reaches into `/app`. The build tree is deleted in the same step, so the
layer holds only `/app`. Left out on purpose: the Agent SDK's own Claude Code binaries (Claude Code
runs inside each Sprite, from Anthropic's installer, checked against the SDK's `manifest.json`, which
stays) and onnxruntime-node's macOS and Windows libraries.

The runtime stage is `node:24.22.2-trixie-slim`, pinned by version and index digest, plus `tini`,
`sqlite3` and `tzdata`; npm and corepack are removed. The container starts as root only for
`factory-entrypoint`: a fresh volume is root's (a Fly volume, or a directory Docker created for a bind
mount, hides the image's `/data`), so when `/data`, `/data/app` or `/data/backups` is not `node`'s it
gives `/data` to node (`chown -R`, only then), and it replaces itself, through `setpriv`, with the
rest as `node` (uid 1000): `tini -> varlock run -> node index.mjs` in the bundle's directory, as `mastra
start` does. tini is PID 1, as node like everything else (a root tini could not signal node's
processes: the container has no `CAP_KILL`), and forwards SIGTERM; varlock checks the environment
against `.env.schema` and redacts the values it marks sensitive from the server's output; Factory's shutdown (`[factory] the server is shutting down;
stopping Factory first`) runs on the signal. Telemetry is off (`MASTRA_TELEMETRY_DISABLED`,
`VARLOCK_TELEMETRY_DISABLED`, `DO_NOT_TRACK`).

What the server does not need with Sprites, so the image does not have: `git` and `gh` (the clone,
commits, pushes and `gh` calls run inside the Sprite through its exec API; the one host-side `git`
call, reading a checkout's instruction files, finds no checkout and returns nothing), a shell toolset,
a browser, and a Claude Agent home: with a Sprite, Claude Code's home, config and transcripts are on
the Sprite's disk (`~/.factory/claude-agent`), and `FACTORY_CLAUDE_AGENT_HOME` is only read for a
local sandbox, which the image refuses.

### What the image sets

| Setting                                                 | Value                                          |
| ------------------------------------------------------- | ---------------------------------------------- |
| `FACTORY_DEPLOYMENT`                                    | `container` (the guard below)                  |
| `FACTORY_SANDBOX_PROVIDER`                              | `sprites`                                      |
| `FACTORY_DATABASE`                                      | `libsql`                                       |
| `MASTRA_APP_DATA_DIR`, `MASTRA_DB_PATH`                 | `/data/app`, `/data/app/mastra.db`             |
| `FACTORY_BACKUP_DIR`                                    | `/data/backups`                                |
| `PORT`, `MASTRA_HOST`                                   | `5873`, `0.0.0.0`                              |
| `NODE_ENV`, `MASTRACODE_UI_DIST`, `MASTRA_PROJECT_ROOT` | `production`, the bundled UI, the host project |

`/data` is the one volume. `$HOME` (`/home/node`) and `/tmp` hold nothing that must survive a restart.

### What the operator sets

Only through the environment (an env file the operator owns, `fly secrets`, the homelab's rendered
`.env`); nothing is baked into the image. Required: `MASTRACODE_PUBLIC_URL`, `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `FACTORY_SESSION_SECRET` (32+ characters),
`FACTORY_CREDENTIAL_ENCRYPTION_KEY` (the key the data was written with), `SPRITES_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, and the `GITHUB_APP_*` group. Optional: `TZ`, `FACTORY_SPRITES_REGION`,
`FACTORY_SPRITES_PREFIX`, and the knobs in `mastracode/web/.env.schema`.

### The guard

`FACTORY_DEPLOYMENT=container` (set by the image) makes the server refuse to start unless
`FACTORY_SANDBOX_PROVIDER=sprites` with `SPRITES_TOKEN`, and refuse `FACTORY_BROWSER=local`: nothing
an agent runs touches the server's host. Any other value of `FACTORY_DEPLOYMENT` is refused too.
Tests: `mastracode/web/src/mastra/production-boot-guards.test.ts`.

## Homelab (Compose)

`compose.yaml` and `compose.env.example` follow tmcdo-me/homelab-compose's conventions, so they can be
copied to `stacks/factory/` as they are:

- `name: factory`, `x-homelab: {host: docker}`; explicit `environment:` (no `env_file:`), secrets as
  `op://Homelab/...` references in `.env.example` (the item names are suggestions);
- `image: ghcr.io/tmcdo-me/factory:${FACTORY_IMAGE_TAG}`, the full commit SHA of a `Fork image` run
  (the exact-release row: a deploy is a PR that moves it; nothing is built on the VM);
- the volume `${APPDATA_ROOT}/factory/data:/data` on the VM's own disk. SQLite's locks and its WAL
  shared memory are not safe on NFS or SMB: never `/mnt/nas`;
- DockTail labels advertise `svc:factory` (443 -> 5873), taking the name over from mac-mini; the port
  is published on `127.0.0.1` only, for `cloudflared-truenas` (host network) and the webhook route;
- `homelab.gate=backup`, `stop_grace_period: 60s`, `restart: unless-stopped`, the image's health
  check, json-file logs capped, a read-only root filesystem with `/tmp` and `$HOME` in memory,
  `no-new-privileges`, and all capabilities dropped but `CHOWN`, `SETUID` and `SETGID`, which the
  entrypoint needs as root and the server, running as node, does not have;
- an explicit `/28` network (the VM's predefined pools are used up; pick a free one).

## Backups

A plain copy of a live SQLite file can be torn or miss what is still in `-wal`, so the snapshot uses
SQLite's online backup API:

```sh
docker compose exec factory-snapshot factory-snapshot   # one now (or `exec factory`)
fly ssh console --app <app> -C factory-snapshot          # on Fly
```

Started as root, as those are, it switches to `node` first, so the lock, `.last-status` and any `-wal`
or `-shm` it opens on the live database stay node's (root-owned ones would stop the server writing). A
stop during a run removes its lock and partial copy.

`factory-snapshot` writes `/data/backups/mastra.db-YYYY-MM-DD` (a second run the same day replaces
it), a standalone file (rollback journal, no `-wal`) that passed `PRAGMA integrity_check` before it took
the name, keeps the newest `FACTORY_BACKUP_KEEP` (7), and records `<epoch> <exit code> <message>` in
`/data/backups/.last-status`. The `factory-snapshot` sidecar runs it daily at `FACTORY_SNAPSHOT_AT`
(02:10, ahead of the 02:30 PBS window) and is unhealthy when the last run failed. The dated name is
backup-verify's dated-copy pattern, so its freshness (96 h) and integrity are checked with no
registration; the live `mastra.db` is checked as every `*.db` is. A database whose schema uses
libSQL's own functions (a vector index in `mastra-vectors.db`, when Mastra Code's recall makes one) is
copied the same way, since the backup API copies pages, but stock SQLite cannot parse its schema, so
libSQL checks the copy (`factory-sqlite-check`) and it is named `mastra-vectors.db.libsql-YYYY-MM-DD`,
outside backup-verify's patterns, which read with stock sqlite3 and would report it corrupt (the live
`mastra-vectors.db` would be, too: exclude it there if it appears). The homelab's rule is that SQLite is
never dumped because PBS's `fs-freeze` image is crash-consistent; the dated copy is the owner's choice
on top of that: a checked database that a restore can take as it is, without replaying a WAL.

Sizing: the volume holds the database, its `-wal`, `FACTORY_BACKUP_KEEP` dated copies and room for
the next, so at least `(FACTORY_BACKUP_KEEP + 2) x` the database. The snapshot fails when there is not
room for the copy, and warns (its log, and `.last-status`, still exit 0) when what is left after it is
under twice the database. Today's database is a few MB.

What is not in it: the environment. `FACTORY_CREDENTIAL_ENCRYPTION_KEY` above all belongs in the
vault; without it the stored model keys and integration secrets cannot be read.

Restore: stop the stack (`docker compose stop factory factory-snapshot`), move `mastra.db`,
`mastra.db-wal` and `mastra.db-shm` in `/data/app` aside, copy the dated file to `/data/app/mastra.db`
(owner uid 1000), start it again.

## Public exposure: GitHub's webhook only

The browser reaches Factory on the tailnet (`https://factory.tail99d67.ts.net`): sign-in, the UI, the
API, the OIDC callback `/auth/callback` and the GitHub App's `/auth/github/callback` are all browser
redirects, so none needs a public route. The one thing that must come from the internet is GitHub's
webhook:

| Method | Path                  | Auth                                                                                                                                                              |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/web/github/webhook` | `X-Hub-Signature-256`, HMAC of the body with `GITHUB_APP_WEBHOOK_SECRET`; refused (401) when the secret is unset, the header is missing or the signature is wrong |

On the homelab's `truenas-scale` tunnel: a hostname (for example `factory-hooks.tmcdo.me`) with one
ingress rule, `path: ^/web/github/webhook$` to `http://127.0.0.1:5873`, and nothing else for that
hostname (the tunnel's terminal `http_status:404` answers every other path). No Cloudflare Access on it
(GitHub cannot pass Access); the signature is the gate. A WAF rule allowing only `POST` from GitHub's
`hooks` ranges (`https://api.github.com/meta`) can be added. In the GitHub App's settings: Webhook
active, URL `https://<that hostname>/web/github/webhook`, secret = `GITHUB_APP_WEBHOOK_SECRET`.
Tailscale Funnel stays off.

Nothing else is public. Slack, if it is turned on later, needs no route in Socket Mode
(`SLACK_APP_TOKEN`); its webhook mode would add `POST /api/agent-controllers/<id>/channels/slack/webhook`
and `GET /connect/slack/*`.

## Fly.io (untested)

An option the owner keeps open, not exercised: nothing here has run on Fly. `fly.toml` passes
`fly config validate`; the image it would build is the one the workflow checks. It is one Machine
(the database is a file one process opens), a volume `factory_data` at `/data` (root's when new; the
entrypoint gives it to node), `kill_timeout = 60`, an HTTP service on 5873 checked on `/auth/me`, and
auto-stop off: the dispatcher, Slack's socket and live Claude Code sessions work with no request in
flight.

```sh
fly apps create <app>                                   # once; set `app` in fly.toml
fly volumes create factory_data --region <region> --size 3
fly secrets set --app <app> \
  OIDC_ISSUER=... OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... FACTORY_SESSION_SECRET=... \
  FACTORY_CREDENTIAL_ENCRYPTION_KEY=... SPRITES_TOKEN=... CLAUDE_CODE_OAUTH_TOKEN=... \
  GITHUB_APP_ID=... GITHUB_APP_CLIENT_ID=... GITHUB_APP_CLIENT_SECRET=... GITHUB_APP_SLUG=... \
  GITHUB_APP_WEBHOOK_SECRET=...
fly secrets set --app <app> GITHUB_APP_PRIVATE_KEY=- < github-app.pem   # multi-line, from stdin
fly deploy . --config fork/deploy/fly.toml \
  --dockerfile fork/deploy/Dockerfile --ignorefile fork/deploy/Dockerfile.dockerignore
fly ssh console --app <app> -C factory-snapshot          # a checked copy now
```

Set `MASTRACODE_PUBLIC_URL` in `[env]` to the Machine's URL (`https://<app>.fly.dev` or a custom
domain) and register `<url>/auth/callback` with the OIDC provider and `<url>/auth/github/callback` and
`<url>/web/github/webhook` with the GitHub App. The Machine is on the internet, not the tailnet: an
OIDC issuer only on the tailnet (Pocket ID at `id.tail99d67.ts.net`) is not reachable from it without
adding Tailscale to the Machine, and the whole app is public behind sign-in rather than only the
webhook. Fly snapshots the volume daily (crash-consistent, kept `snapshot_retention` days); there is
no scheduler for `factory-snapshot` on a single Machine, so run it from `fly ssh console`.

## Moving the data from mac-mini

The host name stays `https://factory.tail99d67.ts.net`, so `MASTRACODE_PUBLIC_URL`, the Pocket ID
client's redirect URI and the GitHub App's callback URLs do not change. Only the webhook URL is new.

1. Before the cut-over: finish or push work in open sessions. On mac-mini sessions run in local
   checkouts (`FACTORY_SANDBOX_PROVIDER=local`) with Claude Code's transcripts in the Mini's Claude
   Agent home; after the move every session runs on a Sprite, which has neither, so unpushed work stays
   on the Mini and a Claude Agent session's next message cannot resume its old conversation
   (`fork/ops/README.md`, "Backups", for where they are). Projects, boards, work items, threads and
   settings all move with the database.
2. Stop the server on mac-mini (`launchctl kill TERM gui/$(id -u)/homelab.factory`, or the `pnpm dev`
   it runs as now), then copy the database with the online backup API, even stopped, so `-wal` is
   folded in:

   ```sh
   sqlite3 "$HOME/Library/Application Support/mastracode/mastra.db" ".backup '/Volumes/Dev/tmp/factory-move/mastra.db'"
   sqlite3 /Volumes/Dev/tmp/factory-move/mastra.db "PRAGMA journal_mode=DELETE; PRAGMA integrity_check;"   # ok
   ```

   (`MASTRA_DB_PATH` in the Mini's `.env`, if set, names the file instead.)

3. Settings: from the Mini's `.env` into the vault items `compose.env.example` names, at least
   `FACTORY_CREDENTIAL_ENCRYPTION_KEY` (the same key, or nothing stored can be read), the OIDC client,
   `FACTORY_SESSION_SECRET` (a new one only signs everyone out), `CLAUDE_CODE_OAUTH_TOKEN`, the GitHub
   App group and `SPRITES_TOKEN`. Drop `FACTORY_SANDBOX_PROVIDER=local`, `MASTRACODE_LOCAL_SANDBOX_ROOT`,
   `FACTORY_CLAUDE_AGENT_HOME` and the data paths: the image sets its own.
4. On the Docker host, with the stack created but `factory` stopped: put the copy at
   `${APPDATA_ROOT}/factory/data/app/mastra.db`, owned by uid 1000, mode 600; start the stack, check
   `/auth/me` and sign in. Take `docker compose exec factory-snapshot factory-snapshot` once.
5. Tailnet: mac-mini stops advertising `svc:factory` (`tailscale serve --service=svc:factory ... off`
   or `reset`), the policy's `autoApprovers` line for it moves from `tag:mac-mini` to DockTail's tag,
   and DockTail's sidecar takes the name (its README's new-Service steps).
6. GitHub App: webhook URL to the tunnel hostname, Active on.

Rolling back is starting mac-mini's server again on its untouched database (writes made in the
container in between stay in the container's copy).

## Verify an image

`fork/deploy/smoke.sh <image>` is what the `Fork image` workflow runs after every build, with a
throwaway volume and env (a fake OIDC issuer, which is fetched only at the first sign-in; random
secrets; a dummy Sprites token and a prefix of its own) and the compose stack's hardening. It checks
that the server answers `/auth/me` and serves the UI, that its processes run as uid 1000 and it goes
healthy, that the guard refuses `FACTORY_SANDBOX_PROVIDER=local`, that a fresh root-owned `/data` is
given to node, that `factory-snapshot` exec'd as root leaves only node's files and copies a libSQL
vector index, that the sidecar loop stops cleanly, and that `docker stop` runs Factory's shutdown and
exits 0 within the grace period. It prints the image's size and cleans up after itself.
