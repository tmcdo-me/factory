#!/bin/sh
# Snapshots the Factory server's data while it runs, into $FACTORY_BACKUP_DIR/<UTC stamp>/, and
# prunes old snapshots. Run daily by the LaunchAgent homelab.factory-backup, and by deploy.sh
# before it switches releases. See fork/ops/README.md ("What is backed up") and restore.sh.
#
# A snapshot holds:
#   mastra.db.gz               the database (threads, messages, boards, work items, projects,
#                              Factory's event log and Claude Agent resume state, encrypted
#                              integration secrets), copied with SQLite's online backup API
#                              (`sqlite3 .backup`), so it is consistent while the server writes,
#                              then checked with `PRAGMA integrity_check`
#   mastra-vectors.db.gz       the recall vector file, when there is one (same method)
#   claude-agent-home.tar.gz   Claude Code's own state for Claude Agent sessions: the session
#                              transcripts that `resume` reads, settings and todos
#   MANIFEST                   sources, release, sizes and SHA-256 of each file
# Never in it: secrets. .env (and the GitHub App key, OIDC and session secrets, the credential
# encryption key and CLAUDE_CODE_OAUTH_TOKEN in it) belongs in the owner's vault; without the
# encryption key the integration secrets in the database cannot be read. Claude Code's
# .credentials.json is skipped, as is Mastra Code's own auth.json.
#
# Settings (environment; a setting not in the environment is read from the server's .env, so
# the backup reads the same paths the server uses):
#   FACTORY_ROOT              (default /Volumes/Dev/factory-app)
#   FACTORY_ENV_FILE          the server's .env (default $FACTORY_ROOT/shared/.env)
#   FACTORY_BACKUP_DIR        where snapshots go (default /Volumes/Dev/factory-backups)
#   FACTORY_BACKUP_KEEP_DAYS  delete snapshots older than this (default 14)
#   FACTORY_BACKUP_KEEP_MIN   but always keep this many of the newest (default 3)
#   MASTRA_DB_PATH, MASTRA_APP_DATA_DIR, FACTORY_CLAUDE_AGENT_HOME   as the server reads them
# Prints the snapshot's path on success; exits non-zero on any failure.
set -eu

FACTORY_ROOT=${FACTORY_ROOT:-/Volumes/Dev/factory-app}
env_file=${FACTORY_ENV_FILE:-$FACTORY_ROOT/shared/.env}
dest_root=${FACTORY_BACKUP_DIR:-/Volumes/Dev/factory-backups}
keep_days=${FACTORY_BACKUP_KEEP_DAYS:-14}
keep_min=${FACTORY_BACKUP_KEEP_MIN:-3}
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
export PATH

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) factory-backup: $*"; }
die() {
  log "FAILED: $*"
  exit 1
}

# One plain setting from .env, without sourcing the file (it holds secrets): the last
# `NAME=value` line, surrounding quotes removed. Only path settings are read this way.
env_value() {
  [ -r "$env_file" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$env_file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
setting() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || value=$(env_value "$1")
  printf '%s' "$value"
}

# Postgres is not this script's job (pg_dump is). Only whether it is set is read, never its value.
if [ -n "${DATABASE_URL:-}" ] || [ -n "$(env_value DATABASE_URL)" ] || [ -n "$(env_value APP_DATABASE_URL)" ]; then
  die "the server uses Postgres (DATABASE_URL); back that database up with pg_dump"
fi

db=$(setting MASTRA_DB_PATH)
app_data=$(setting MASTRA_APP_DATA_DIR)
[ -n "$app_data" ] || app_data="$HOME/Library/Application Support/mastracode"
[ -n "$db" ] || db="$app_data/mastra.db"
vectors="$(dirname "$db")/mastra-vectors.db"
claude_home=$(setting FACTORY_CLAUDE_AGENT_HOME)
[ -n "$claude_home" ] || claude_home="$HOME/.mastracode/web/claude-agent-home"

[ -f "$db" ] || die "no database at $db"
mkdir -p "$dest_root"
chmod 700 "$dest_root"

lock="$dest_root/.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A lock left by a run that died (older than 6 hours) is cleared; a live one stops this run.
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
    if ! { rmdir "$lock" && mkdir "$lock"; }; then die "could not take $lock"; fi
  else
    die "another backup is running ($lock)"
  fi
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$dest_root/$stamp.partial"
trap 'rm -rf "$work"; rmdir "$lock" 2>/dev/null || true' EXIT
mkdir "$work"

# SQLite's online backup API, through the system sqlite3 (libSQL's files are SQLite files). It
# copies one consistent snapshot while the server keeps writing (WAL mode), waiting up to 30 s
# for a lock. Copying the file instead can capture a torn database or miss what is still in -wal.
snapshot_db() {
  src=$1
  name=$2
  sqlite3 -cmd ".timeout 30000" "$src" ".backup '$work/$name'" ||
    die "sqlite3 .backup of $src failed"
  # A standalone file: the copy keeps the source's WAL mode, and Apple's sqlite3 keeps -wal and -shm
  # files after close, so switch it to a rollback journal before checking it.
  sqlite3 "$work/$name" "PRAGMA journal_mode=DELETE;" >/dev/null || die "could not finish $name"
  check=$(sqlite3 "$work/$name" "PRAGMA integrity_check;") || die "could not check $name"
  rm -f "$work/$name-wal" "$work/$name-shm"
  [ "$check" = "ok" ] || die "$name failed integrity_check: $(echo "$check" | head -n 3)"
  gzip -6 "$work/$name"
  log "$name: $(wc -c <"$work/$name.gz" | tr -d ' ') bytes compressed, integrity ok"
}
snapshot_db "$db" mastra.db
if [ -f "$vectors" ]; then snapshot_db "$vectors" mastra-vectors.db; fi

# Claude Code's state for Factory's sessions (CLAUDE_CONFIG_DIR is <home>/.claude). Transcripts
# are append-only JSONL, so one written during the copy can end in a partial line, which resume
# skips. Left out: the login (.credentials.json, normally absent: the server passes
# CLAUDE_CODE_OAUTH_TOKEN), logs and caches, and <home>/factory-skills, which Factory writes
# again at every session open; so are tool caches that commands left in <home>.
if [ -d "$claude_home/.claude" ]; then
  members=.claude
  if [ -f "$claude_home/.claude.json" ]; then members=".claude .claude.json"; fi
  # shellcheck disable=SC2086 # members is a fixed list of two names
  tar -C "$claude_home" -czf "$work/claude-agent-home.tar.gz" \
    --exclude '.claude/.credentials.json' \
    --exclude '.claude/debug' \
    --exclude '.claude/shell-snapshots' \
    --exclude '.claude/statsig' \
    --exclude '.claude/telemetry' \
    --exclude '.claude/cache' \
    $members || die "archiving $claude_home failed"
  log "claude-agent-home.tar.gz: $(wc -c <"$work/claude-agent-home.tar.gz" | tr -d ' ') bytes"
else
  log "no Claude Agent home at $claude_home/.claude (no Claude Agent session has run yet); skipped"
fi

release=$(readlink "$FACTORY_ROOT/current" 2>/dev/null || echo unknown)
{
  echo "created: $stamp"
  echo "host: $(hostname)"
  echo "release: $release"
  echo "database: $db"
  echo "claude-agent-home: $claude_home"
  echo "not included: .env and other secrets (owner's vault); sandbox checkouts (re-cloned on a session's next start)"
  echo
  (cd "$work" && for f in *; do
    [ "$f" = MANIFEST ] || echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  $(wc -c <"$f" | tr -d ' ')  $f"
  done)
} >"$work/MANIFEST"

mv "$work" "$dest_root/$stamp"
chmod -R go-rwx "$dest_root/$stamp"
log "snapshot $dest_root/$stamp"

# Retention: snapshots past keep_days go, except the newest keep_min. Abandoned .partial
# directories older than a day go too.
find "$dest_root" -maxdepth 1 -type d -name '*.partial' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
count=0
# shellcheck disable=SC2010 # snapshot names are this script's own UTC stamps
for snapshot in $(ls -1 "$dest_root" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r); do
  count=$((count + 1))
  [ "$count" -le "$keep_min" ] && continue
  if [ -n "$(find "$dest_root/$snapshot" -maxdepth 0 -mtime +"$keep_days")" ]; then
    rm -rf "${dest_root:?}/$snapshot"
    log "pruned $snapshot"
  fi
done

echo "$dest_root/$stamp"
