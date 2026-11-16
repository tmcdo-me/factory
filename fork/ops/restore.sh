#!/bin/sh
# Restores a snapshot made by backup.sh, with the server stopped:
#
#   launchctl kill TERM gui/$(id -u)/homelab.factory     # stops it; KeepAlive leaves a clean exit down
#   fork/ops/restore.sh /Volumes/Dev/factory-backups/<stamp>
#   launchctl kickstart gui/$(id -u)/homelab.factory
#
# What is there now is moved aside, never deleted: the database and its -wal and -shm files become
# <name>.pre-restore-<stamp> (a -wal left beside the restored file would be replayed into it and
# corrupt it), and the Claude Agent home's .claude becomes .claude.pre-restore-<stamp>. The paths
# are the server's, read as backup.sh reads them (same settings). See fork/ops/README.md.
set -eu

snapshot=${1:?usage: restore.sh <snapshot directory>}
FACTORY_ROOT=${FACTORY_ROOT:-/Volumes/Dev/factory-app}
env_file=${FACTORY_ENV_FILE:-$FACTORY_ROOT/shared/.env}
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
export PATH

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) factory-restore: $*"; }
die() {
  log "FAILED: $*"
  exit 1
}
env_value() {
  [ -r "$env_file" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$env_file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
setting() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || value=$(env_value "$1")
  printf '%s' "$value"
}

[ -f "$snapshot/MANIFEST" ] && [ -f "$snapshot/mastra.db.gz" ] || die "$snapshot is not a backup.sh snapshot"
db=$(setting MASTRA_DB_PATH)
app_data=$(setting MASTRA_APP_DATA_DIR)
[ -n "$app_data" ] || app_data="$HOME/Library/Application Support/mastracode"
[ -n "$db" ] || db="$app_data/mastra.db"
claude_home=$(setting FACTORY_CLAUDE_AGENT_HOME)
[ -n "$claude_home" ] || claude_home="$HOME/.mastracode/web/claude-agent-home"

# Nothing may have the database open: the LaunchAgent's server, a hand-started `pnpm dev`, or
# Mastra Code's CLI, which opens the same default file.
# (lsof fails when any file it is given is missing, so each is asked about on its own.)
for f in "$db" "$db-wal"; do
  if [ -e "$f" ] && [ -n "$(lsof -t -- "$f" 2>/dev/null)" ]; then
    die "$f is open (lsof); stop the server first: launchctl kill TERM gui/$(id -u)/homelab.factory"
  fi
done

# The snapshot is what backup.sh wrote.
(cd "$snapshot" && sed -n 's/^\([0-9a-f]\{64\}\)  [0-9]*  \(.*\)$/\1  \2/p' MANIFEST | shasum -a 256 -c --quiet) ||
  die "$snapshot does not match its MANIFEST"

# The pid keeps two restores in the same second from moving onto each other's copies.
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
restore_db() {
  target=$1
  archive=$2
  mkdir -p "$(dirname "$target")"
  for suffix in "" -wal -shm; do
    if [ -e "$target$suffix" ]; then mv "$target$suffix" "$target$suffix.pre-restore-$stamp"; fi
  done
  gunzip -c "$archive" >"$target.restoring"
  [ "$(sqlite3 "$target.restoring" 'PRAGMA integrity_check;')" = "ok" ] || die "$archive failed integrity_check"
  mv "$target.restoring" "$target"
  chmod 600 "$target"
  log "restored $target (the previous one is $target.pre-restore-$stamp)"
}
restore_db "$db" "$snapshot/mastra.db.gz"
if [ -f "$snapshot/mastra-vectors.db.gz" ]; then
  restore_db "$(dirname "$db")/mastra-vectors.db" "$snapshot/mastra-vectors.db.gz"
fi

if [ -f "$snapshot/claude-agent-home.tar.gz" ]; then
  mkdir -p "$claude_home"
  if [ -e "$claude_home/.claude" ]; then mv "$claude_home/.claude" "$claude_home/.claude.pre-restore-$stamp"; fi
  if [ -e "$claude_home/.claude.json" ]; then mv "$claude_home/.claude.json" "$claude_home/.claude.json.pre-restore-$stamp"; fi
  tar -C "$claude_home" -xzf "$snapshot/claude-agent-home.tar.gz"
  log "restored $claude_home/.claude (the previous one is .claude.pre-restore-$stamp)"
fi

log "done; start the server: launchctl kickstart gui/$(id -u)/homelab.factory"
