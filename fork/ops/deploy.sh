#!/bin/sh
# Deploys the Factory server on this machine, or rolls it back. See fork/ops/README.md.
#
#   deploy.sh                 build origin's main as a new release and switch to it
#   deploy.sh <ref>           the same for a branch, tag or commit of origin
#   deploy.sh rollback [rel]  switch back to the previous release (or the one named), no build
#   deploy.sh status          which release runs, and which are kept
#
# Layout under $FACTORY_ROOT (default /Volumes/Dev/factory-app):
#   repo.git/                 a bare clone of the repository; each deploy fetches it
#   releases/<stamp>-<sha>/   one checkout per deploy, installed and built in place
#   current -> releases/...   what the LaunchAgent runs (factory-start.sh)
#   shared/.env               the server's settings and secrets, from the owner's vault; every
#                             release's mastracode/web/.env links to it
#   turbo-cache/              build cache shared by releases, so a deploy rebuilds what changed
#
# A deploy builds the new release beside the running one, so the server keeps serving the old
# build until the switch: a failed build changes nothing. Then it snapshots the data
# (backup.sh), points `current` at the new release, restarts the LaunchAgent
# (`launchctl kickstart -k`, a graceful SIGTERM) and waits for the new server to answer; if it
# does not within FACTORY_DEPLOY_WAIT seconds, it switches back and restarts the old one.
# Rolling back switches code only: a release that changed the database's schema may need the
# snapshot taken before it (restore.sh), and the deploy prints which one that is.
#
# Settings (environment):
#   FACTORY_ROOT, FACTORY_REPO_URL (default https://github.com/tmcdo-me/factory.git)
#   FACTORY_LABEL          the LaunchAgent (default homelab.factory)
#   FACTORY_PORT           where the server answers (default 5873)
#   FACTORY_KEEP_RELEASES  releases kept, the running one included (default 2; about 1 GB each)
#   FACTORY_DEPLOY_WAIT    seconds to wait for the new server (default 180)
#   FACTORY_DEPLOY_SKIP_BACKUP=1   skip the pre-switch snapshot (a first install with no database)
set -eu

FACTORY_ROOT=${FACTORY_ROOT:-/Volumes/Dev/factory-app}
repo_url=${FACTORY_REPO_URL:-https://github.com/tmcdo-me/factory.git}
label=${FACTORY_LABEL:-homelab.factory}
port=${FACTORY_PORT:-5873}
keep=${FACTORY_KEEP_RELEASES:-2}
wait_s=${FACTORY_DEPLOY_WAIT:-180}
log_file=${FACTORY_LOG_DIR:-$HOME/Library/Logs/factory}/factory.log
service="gui/$(id -u)/$label"

export PATH="${FACTORY_PATH:-$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin}"
export TMPDIR="${FACTORY_TMPDIR:-/Volumes/Dev/tmp/}"
export TURBO_CACHE_DIR="$FACTORY_ROOT/turbo-cache"
export TURBO_TELEMETRY_DISABLED=1

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) factory-deploy: $*"; }
die() {
  log "FAILED: $*"
  exit 1
}

releases="$FACTORY_ROOT/releases"
current_release() { basename "$(readlink "$FACTORY_ROOT/current" 2>/dev/null || echo none)"; }
# Newest first.
# shellcheck disable=SC2010 # release names are this script's own <stamp>-<sha>
list_releases() { ls -1 "$releases" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$' | sort -r || true; }
agent_loaded() { launchctl print "$service" >/dev/null 2>&1; }

switch_to() {
  # BSD ln: -h replaces the link itself instead of writing into the directory it points at.
  ln -sfh "releases/$1" "$FACTORY_ROOT/current"
  log "current -> releases/$1"
}

# Restart the LaunchAgent and wait until the server it started is the release `current` names and
# answers /auth/me. Returns non-zero when it does not in time.
restart_and_wait() {
  want=$1
  if ! agent_loaded; then
    log "LaunchAgent $label is not loaded; not restarting (install it: fork/ops/README.md)"
    return 0
  fi
  log_lines=$(wc -l <"$log_file" 2>/dev/null | tr -d ' ' || echo 0)
  launchctl kickstart -k "$service"
  log "restarted $label; waiting up to ${wait_s}s for release $want on 127.0.0.1:$port"
  waited=0
  while [ "$waited" -lt "$wait_s" ]; do
    if tail -n +"$((log_lines + 1))" "$log_file" 2>/dev/null | grep -q "starting release $want " &&
      [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/auth/me" 2>/dev/null)" = 200 ]; then
      log "release $want is up"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

lock="$FACTORY_ROOT/.deploy.lock"
mkdir -p "$FACTORY_ROOT" "$releases" "$FACTORY_ROOT/shared"
mkdir "$lock" 2>/dev/null || die "another deploy is running ($lock; remove it if none is)"
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

case "${1:-}" in
status)
  log "running: $(current_release)"
  for r in $(list_releases); do echo "  $r"; done
  exit 0
  ;;
rollback)
  now=$(current_release)
  target=${2:-}
  if [ -z "$target" ]; then
    # The release just older than the running one (the list is newest first).
    seen=0
    for r in $(list_releases); do
      if [ "$seen" = 1 ]; then
        target=$r
        break
      fi
      [ "$r" = "$now" ] && seen=1
    done
  fi
  [ -n "$target" ] && [ -d "$releases/$target" ] || die "no release to roll back to from $now (deploy.sh status)"
  switch_to "$target"
  restart_and_wait "$target" || die "release $target did not come up; logs: $log_file"
  log "rolled back from $now to $target (the code only: restore.sh puts back data from before a deploy)"
  exit 0
  ;;
esac

ref=${1:-main}
[ -r "$FACTORY_ROOT/shared/.env" ] ||
  die "no $FACTORY_ROOT/shared/.env: put the server's .env there (from the owner's vault), mode 600"

if [ ! -d "$FACTORY_ROOT/repo.git" ]; then
  log "cloning $repo_url"
  git clone --quiet --bare "$repo_url" "$FACTORY_ROOT/repo.git"
fi
log "fetching $repo_url"
git -C "$FACTORY_ROOT/repo.git" fetch --quiet --prune "$repo_url" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
if ! sha=$(git -C "$FACTORY_ROOT/repo.git" rev-parse --verify --quiet "$ref^{commit}"); then
  # A commit not on any branch (an open pull request's head, say).
  git -C "$FACTORY_ROOT/repo.git" fetch --quiet "$repo_url" "$ref" || die "no ref $ref in $repo_url"
  sha=$(git -C "$FACTORY_ROOT/repo.git" rev-parse --verify "FETCH_HEAD^{commit}")
fi
short=$(echo "$sha" | cut -c1-12)
case "$(current_release)" in
*-"$short")
  if [ "${FACTORY_DEPLOY_FORCE:-}" != 1 ]; then
    log "$ref ($short) is already running; FACTORY_DEPLOY_FORCE=1 rebuilds it"
    exit 0
  fi
  ;;
esac

name="$(date -u +%Y%m%dT%H%M%SZ)-$short"
dir="$releases/$name"
log "building $ref ($short) in releases/$name"
git clone --quiet --local --no-checkout "$FACTORY_ROOT/repo.git" "$dir"
git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach "$sha"
# pnpm's machine-wide store and virtual store make these installs mostly links.
(cd "$dir" && pnpm install --frozen-lockfile) || die "pnpm install failed in releases/$name"
(cd "$dir" && pnpm --dir mastracode/web install --frozen-lockfile) || die "pnpm install (mastracode/web) failed"
# `build` runs `prebuild` first: the workspace packages the server links, then `mastra build`.
(cd "$dir" && pnpm --dir mastracode/web build) || die "build failed in releases/$name (the running release is unchanged)"
[ -f "$dir/mastracode/web/.mastra/output/index.mjs" ] && [ -f "$dir/mastracode/web/.mastra/output/factory/index.html" ] ||
  die "build of releases/$name has no server entry or UI"
ln -s "$FACTORY_ROOT/shared/.env" "$dir/mastracode/web/.env"

previous=$(current_release)
snapshot=""
if [ "${FACTORY_DEPLOY_SKIP_BACKUP:-}" != 1 ]; then
  snapshot=$("$dir/fork/ops/backup.sh" | tail -n 1) ||
    die "pre-deploy backup failed; nothing switched (a first install with no database yet: FACTORY_DEPLOY_SKIP_BACKUP=1)"
  log "data before the switch: $snapshot"
fi

switch_to "$name"
if ! restart_and_wait "$name"; then
  log "release $name did not answer within ${wait_s}s; logs: $log_file"
  if [ "$previous" != none ] && [ -d "$releases/$previous" ]; then
    switch_to "$previous"
    restart_and_wait "$previous" || log "the previous release $previous did not come up either"
    die "switched back to $previous${snapshot:+; if $name changed the database, restore $snapshot}"
  fi
  die "release $name did not come up and there is no previous release"
fi

# Keep the newest $keep releases (the running one is the newest).
count=0
for r in $(list_releases); do
  count=$((count + 1))
  if [ "$count" -gt "$keep" ] && [ "$r" != "$name" ]; then
    rm -rf "${releases:?}/$r"
    log "removed old release $r"
  fi
done
# Build cache entries no deploy used for two weeks.
find "$TURBO_CACHE_DIR" -type f -mtime +14 -delete 2>/dev/null || true

log "deployed $ref ($short) as $name (was $previous)"
