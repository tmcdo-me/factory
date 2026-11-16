# syntax=docker/dockerfile:1.7
#
# The Factory server (mastracode/web) as a container image. Fork-only; see fork/deploy/README.md.
#
#   docker build -f fork/deploy/Dockerfile -t factory:dev .          # from the repository root
#
# The build context is the repository root (fork/deploy/Dockerfile.dockerignore keeps it small: no
# node_modules, build output, .git or .env). Sessions never run in this container: the image sets
# FACTORY_DEPLOYMENT=container, so the server refuses to start unless every session runs on a Fly.io
# Sprite (FACTORY_SANDBOX_PROVIDER=sprites with SPRITES_TOKEN). What the server keeps is one volume at
# /data: the libSQL database (/data/app/mastra.db) and its snapshots (/data/backups). Configuration and
# secrets come from the environment only; nothing is baked in.

# Node 24 (@fly/sprites needs Node >= 24), Debian 13, pinned by version and by the index digest of that
# version's multi-arch image (amd64 for the homelab and Fly, arm64 for a Mac).
ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

# ---------------------------------------------------------------------------------------------------
# build: install the workspace packages the server links, build them and the server bundle (the same
# `pnpm --dir mastracode/web build` as fork/ops/deploy.sh), then keep only what the server loads.
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    MASTRA_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The repository's pnpm (package.json `packageManager`); mastracode/web, which names none, uses it too.
RUN npm install --global --no-fund --no-audit pnpm@11.21.0

# The workspace packages the server's bundle loads at run time, and the build tools they need. This is
# mastracode/web's `prebuild` filter and the host's `link:` dependencies, each with its dependencies;
# the rest of the monorepo is never installed.
ARG WORKSPACE_FILTER="--filter mastra-turbo \
  --filter {./mastracode/sdk}... --filter {./mastracode/factory}... --filter {./auth/workos}... \
  --filter {./client-sdks/client-js}... --filter {./stores/libsql}... --filter {./stores/pg}... \
  --filter {./server-adapters/hono}... --filter {./workspaces/platform-workspace}... \
  --filter {./pubsub/redis-streams}... --filter {./workspaces/e2b}... --filter {./browser/agent-browser}... \
  --filter {./mastracode/auth-oidc}... --filter {./mastracode/sandbox-sprites}... --filter {./packages/cli}... \
  --filter {./mastracode/runtime-claude-agent}... --filter {./packages/core}..."

# One step, so its layer holds only what is left at its end: /app, the server's run-time tree. The
# sources come in through a bind mount and are copied in the step, pnpm's store lives in the step with
# node_modules hard-linked to it (a cache mount is another filesystem, where pnpm copies every file),
# and fork/deploy/stage-runtime.mjs hard-links what the server loads into /app before /src goes.
# turbo's cache is a cache mount, so a retried build reuses the packages it built.
#  - The machine-global virtual store the checkouts use (pnpm-workspace.yaml) would leave node_modules
#    pointing outside the image, so it is off here.
#  - @mastra/connect's build regenerates the docs site's provider pages and formats them with the docs
#    package's tools, which are not installed; the server reads none of it.
#  - Left out of /app: the Agent SDK's own Claude Code binaries (~330 MB; Claude Code runs inside each
#    Sprite, installed there from Anthropic's installer and checked against the SDK's manifest.json,
#    which stays), and onnxruntime-node's macOS and Windows libraries (~220 MB).
WORKDIR /src
RUN --mount=type=bind,target=/context \
    --mount=type=cache,id=factory-turbo-cache,target=/turbo-cache \
    set -eux; \
    cp -a /context/. /src/; \
    sed -i 's/^enableGlobalVirtualStore: true$/enableGlobalVirtualStore: false/' \
      pnpm-workspace.yaml mastracode/web/pnpm-workspace.yaml; \
    node -e 'const f="packages/connect/package.json",fs=require("fs"),j=JSON.parse(fs.readFileSync(f));j.scripts["generate:provider-docs"]="echo provider docs: not built in the image";fs.writeFileSync(f,JSON.stringify(j,null,2))'; \
    store=/src/.pnpm-store; \
    pnpm install --frozen-lockfile --store-dir "$store" --package-import-method hardlink ${WORKSPACE_FILTER}; \
    pnpm --dir mastracode/web install --frozen-lockfile --store-dir "$store" --package-import-method hardlink; \
    rm -rf "$store" /root/.cache /root/.local/share/pnpm; \
    TURBO_CACHE_DIR=/turbo-cache pnpm --dir mastracode/web build; \
    test -f mastracode/web/.mastra/output/index.mjs; \
    test -f mastracode/web/.mastra/output/factory/index.html; \
    node fork/deploy/stage-runtime.mjs /src /app --skip @anthropic-ai/claude-agent-sdk-; \
    find /app -type d -path '*/onnxruntime-node/bin/napi-v*/*' \( -name darwin -o -name win32 \) -prune \
      -exec rm -rf {} +; \
    cd /; \
    rm -rf /src /root/.npm

# ---------------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini: PID 1, forwards SIGTERM to the server so Factory's shutdown runs, reaps orphans.
# sqlite3: factory-snapshot's online backup (`.backup`) and integrity check. tzdata: so TZ applies (the
# snapshot's daily time, log times). Nothing else: with every session on a Sprite the server itself runs
# no git, gh or shell tools (it clones, commits and pushes inside the Sprite).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini sqlite3 tzdata; \
    rm -rf /var/lib/apt/lists/*; \
    # npm and corepack are build tools; the server is node and its own files.
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
    mkdir -p /data/app /data/backups; \
    chown -R node:node /data

COPY --from=build /app /app
COPY --chmod=0755 fork/deploy/factory-snapshot.sh /usr/local/bin/factory-snapshot
COPY --chmod=0755 fork/deploy/factory-healthcheck.mjs /usr/local/bin/factory-healthcheck

# Settings the image decides (no CLI or usage telemetry from Mastra or varlock: fork/specs §11); everything else (MASTRACODE_PUBLIC_URL, OIDC_*, FACTORY_SESSION_SECRET,
# FACTORY_CREDENTIAL_ENCRYPTION_KEY, SPRITES_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, GITHUB_APP_*, …) is the
# operator's environment. See fork/deploy/README.md and mastracode/web/.env.schema.
ENV NODE_ENV=production \
    PORT=5873 \
    MASTRA_HOST=0.0.0.0 \
    MASTRA_SKIP_DOTENV=1 \
    MASTRA_TELEMETRY_DISABLED=1 \
    VARLOCK_TELEMETRY_DISABLED=true \
    DO_NOT_TRACK=1 \
    MASTRA_PROJECT_ROOT=/app/mastracode/web \
    MASTRACODE_UI_DIST=/app/mastracode/web/.mastra/output/factory \
    FACTORY_DEPLOYMENT=container \
    FACTORY_SANDBOX_PROVIDER=sprites \
    FACTORY_DATABASE=libsql \
    MASTRA_APP_DATA_DIR=/data/app \
    MASTRA_DB_PATH=/data/app/mastra.db \
    FACTORY_BACKUP_DIR=/data/backups

USER node
WORKDIR /app/mastracode/web/.mastra/output
VOLUME ["/data"]
EXPOSE 5873

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["factory-healthcheck"]

# The chain is tini -> varlock -> node. varlock checks the environment against .env.schema and redacts
# the values it marks sensitive from the server's output; each step forwards SIGTERM and waits. The
# working directory is the bundle's, as `mastra start` runs it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/mastracode/web/node_modules/varlock/bin/cli.js", "run", "--path", "/app/mastracode/web/", "--", "node", "index.mjs"]
