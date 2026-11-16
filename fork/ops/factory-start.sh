#!/bin/sh
# Starts the Factory server from its production build, in the foreground, for the LaunchAgent
# homelab.factory (fork/ops/homelab.factory.plist). See fork/ops/README.md.
#
# It runs the release `$FACTORY_ROOT/current` points at (deploy.sh builds one and moves the link),
# with that release's mastracode/web/.env, which is a link to `$FACTORY_ROOT/shared/.env`. The
# chain is this script (exec) -> varlock run -> mastra start -> node index.mjs; each forwards
# SIGTERM and waits, so `launchctl kickstart -k` or a stop drains requests, stops Claude Code and
# the dispatcher, releases the Claude Agent host lease and closes the database before it exits.
#
# Settings (environment; the defaults are mac-mini's):
#   FACTORY_ROOT    where releases live (default /Volumes/Dev/factory-app)
#   FACTORY_APP_DIR the checkout to run (default $FACTORY_ROOT/current)
#   FACTORY_PORT    port to listen on (default 5873, what svc:factory proxies to)
#   FACTORY_HOST    address to bind (default 127.0.0.1: reachable only through Tailscale serve)
#   FACTORY_LOG_DIR log directory (default ~/Library/Logs/factory)
#   FACTORY_TMPDIR  TMPDIR for the server and its sessions (default /Volumes/Dev/tmp/)
#   FACTORY_PATH    PATH; must reach node and pnpm (default: mise's shims, then Homebrew)
set -eu

FACTORY_ROOT=${FACTORY_ROOT:-/Volumes/Dev/factory-app}
app=${FACTORY_APP_DIR:-$FACTORY_ROOT/current}
web="$app/mastracode/web"
log_dir=${FACTORY_LOG_DIR:-$HOME/Library/Logs/factory}

mkdir -p "$log_dir"
# launchd already sends stdout and stderr here (the plist's StandardOutPath); appending again
# keeps the log when the script is started some other way.
exec >>"$log_dir/factory.log" 2>&1

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Not installed yet: exit 0, so KeepAlive {SuccessfulExit: false} leaves the job stopped instead of
# restarting it every ThrottleInterval. deploy.sh kickstarts it once there is something to run.
if [ ! -f "$web/.mastra/output/index.mjs" ]; then
  echo "$(stamp) factory-start: no build at $web/.mastra/output; run fork/ops/deploy.sh"
  exit 0
fi
if [ ! -r "$web/.env" ]; then
  echo "$(stamp) factory-start: no $web/.env (deploy.sh links it to $FACTORY_ROOT/shared/.env)"
  exit 0
fi

export PATH="${FACTORY_PATH:-$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin}"
# launchd gives every agent the per-user /var/folders TMPDIR on the system drive; this machine
# keeps scratch on the Dev volume.
export TMPDIR="${FACTORY_TMPDIR:-/Volumes/Dev/tmp/}"
export PORT="${FACTORY_PORT:-5873}"
export MASTRA_HOST="${FACTORY_HOST:-127.0.0.1}"
# varlock loads .env (validated against .env.schema); `mastra start` must not load it again raw.
export MASTRA_SKIP_DOTENV=1
# No CLI or usage telemetry from this server (fork/specs/claude-agent-core.md §11).
export MASTRA_TELEMETRY_DISABLED=1

cd "$web"
release=$(basename "$(cd "$app" && pwd -P)")
echo "$(stamp) factory-start: starting release $release on $MASTRA_HOST:$PORT (pid $$)"
# The same command as `pnpm start`, without pnpm in the signal path. MASTRACODE_PUBLIC_URL comes
# from .env; the fallback matches `pnpm dev`'s.
# shellcheck disable=SC2016 # expanded by the inner sh, after varlock has loaded .env
exec ./node_modules/.bin/varlock run -- sh -c \
  'MASTRACODE_PUBLIC_URL=${MASTRACODE_PUBLIC_URL:-http://localhost:$PORT} exec ./node_modules/.bin/mastra start'
