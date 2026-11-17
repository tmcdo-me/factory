#!/bin/sh
# An online, consistent copy of the Factory server's database, taken while the server runs, onto the
# same volume: installed in the image as /usr/local/bin/factory-snapshot. See fork/deploy/README.md.
#
#   factory-snapshot              take one now (what a backup runs before it copies the volume:
#                                 `docker compose exec factory-snapshot factory-snapshot`)
#   factory-snapshot --at HH:MM   take one every day at HH:MM (00:00-23:59, local time, TZ) and keep
#                                 running: the compose stack's `factory-snapshot` sidecar
#
# It writes $FACTORY_BACKUP_DIR/mastra.db-YYYY-MM-DD (today's date; a second run the same day replaces
# it), made with SQLite's online backup API (`sqlite3 .backup`), so it is consistent while the server
# writes: a plain copy of the live file can be torn, or miss what is still in mastra.db-wal. The copy
# is a standalone SQLite file (rollback journal, no -wal) that passed `PRAGMA integrity_check` before it
# took the name, so the newest dated copy is always a whole, checked database. mastra-vectors.db beside
# the database, when there is one, gets the same. Only the newest $FACTORY_BACKUP_KEEP dated copies stay.
# Every run records `<epoch> <exit code> <message>` in $FACTORY_BACKUP_DIR/.last-status.
#
# A database whose schema uses libSQL's own functions (a vector index, `libsql_vector_idx`, as in
# mastra-vectors.db) is copied the same way, since the backup API copies pages, but stock SQLite cannot
# parse that schema to check it: libSQL checks it instead (factory-sqlite-check, through the server's
# own @libsql/client), and the copy is named <file>.libsql-YYYY-MM-DD, so a checker that reads every
# `*.db-YYYY-MM-DD` with stock sqlite3 (homelab backup-verify) does not report it as corrupt.
#
# It always runs as the server's user: started as root (`docker compose exec`, `fly ssh console`) it
# switches to `node` first, so nothing it leaves on the volume (.lock, .last-status, a -wal or -shm
# of the live database) is root's. A stop (SIGTERM) removes the lock and the partial copy.
# It warns, in its log and in .last-status, when the volume has less than twice the database free.
#
# Never in it: secrets. The environment (FACTORY_CREDENTIAL_ENCRYPTION_KEY above all: without it the
# integration secrets in the database cannot be read) belongs in the operator's vault.
#
# Settings (environment, as the image sets them):
#   MASTRA_DB_PATH, MASTRA_APP_DATA_DIR   the database, as the server reads them (/data/app/mastra.db)
#   FACTORY_BACKUP_DIR                    where copies go (default /data/backups)
#   FACTORY_BACKUP_KEEP                   dated copies kept (default 7)
#   FACTORY_SQLITE_CHECK                  libSQL's checker (default factory-sqlite-check)
# Prints the copy's path; exits non-zero on any failure (in --at mode it logs and tries again tomorrow).
set -eu

if [ "$(id -u)" = 0 ]; then
  self=$(command -v "$0" 2>/dev/null || echo "$0")
  exec setpriv --reuid=node --regid=node --init-groups -- "$self" "$@"
fi

# The copies hold conversations and encrypted secrets: only the server's user reads them.
umask 077

dest=${FACTORY_BACKUP_DIR:-/data/backups}
keep=${FACTORY_BACKUP_KEEP:-7}
checker=${FACTORY_SQLITE_CHECK:-factory-sqlite-check}
db=${MASTRA_DB_PATH:-}
[ -n "$db" ] || db="${MASTRA_APP_DATA_DIR:-/data/app}/mastra.db"
vectors="$(dirname "$db")/mastra-vectors.db"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) factory-snapshot: $*" >&2; }

# What a stop must not leave behind: the lock this run holds and the copy it is writing.
held_lock=""
writing=""
cleanup() {
  if [ -n "$writing" ]; then rm -f "$writing" "$writing-journal" "$writing-wal" "$writing-shm"; fi
  writing=""
  if [ -n "$held_lock" ]; then rmdir "$held_lock" 2>/dev/null || true; fi
  held_lock=""
}

# Bytes of a database with its -wal (what a copy of it needs), and bytes free where copies go.
db_bytes() {
  total=$(wc -c <"$1" | tr -d ' ')
  if [ -f "$1-wal" ]; then total=$((total + $(wc -c <"$1-wal" | tr -d ' '))); fi
  echo "$total"
}
free_bytes() { df -Pk "$1" | awk 'NR == 2 { print $4 * 1024 }'; }
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }

# One snapshot, in this shell (so a stop's trap sees what it holds). Sets `message` to the copy's path,
# or to why it failed; returns non-zero on failure.
message=""
snapshot() {
  [ -f "$db" ] || { message="no database at $db"; return 1; }
  case "$keep" in '' | *[!0-9]* | 0)
    message="FACTORY_BACKUP_KEEP must be a positive number, not '$keep'"
    return 1
    ;;
  esac
  # Others may pass through the directory (a health check running as root without capabilities reads
  # .last-status) but not list it; the copies themselves are the server user's only.
  if ! { mkdir -p "$dest" && chmod 711 "$dest"; }; then
    message="cannot create $dest"
    return 1
  fi

  if ! mkdir "$dest/.lock" 2>/dev/null; then
    # A lock left by a run that was killed (older than 6 hours) is cleared; a live one stops this run.
    if [ -n "$(find "$dest/.lock" -maxdepth 0 -mmin +360 2>/dev/null)" ] && rmdir "$dest/.lock" &&
      mkdir "$dest/.lock"; then
      :
    else
      message="another snapshot is running ($dest/.lock)"
      return 1
    fi
  fi
  held_lock="$dest/.lock"

  day=$(date +%Y-%m-%d)
  needed=0
  first=""
  for source in "$db" "$vectors"; do
    [ -f "$source" ] || continue
    size=$(db_bytes "$source")
    needed=$((needed + size))
    free=$(free_bytes "$dest")
    if [ "$free" -lt "$size" ]; then
      message="not enough space in $dest for a copy of $source: $(mb "$free") free, $(mb "$size") needed"
      cleanup
      return 1
    fi
    if ! copy_one "$source" "$day"; then
      cleanup
      return 1
    fi
    [ -n "$first" ] || first=$copied
  done
  cleanup
  prune "$(basename "$db")"
  prune "$(basename "$vectors")"
  message=$first
  free=$(free_bytes "$dest")
  if [ "$free" -lt $((needed * 2)) ]; then
    warning="WARNING: $(mb "$free") free on $dest, under twice the database ($(mb "$needed")); grow the volume"
    log "$warning"
    message="$message; $warning"
  fi
  return 0
}

# copy_one <live database> <day>: online backup to a temporary name, made standalone and checked, then
# renamed over today's name in one step. Sets `copied` to that name.
copy_one() {
  source=$1
  writing="$dest/$(basename "$source").partial"
  rm -f "$writing" "$writing-journal" "$writing-wal" "$writing-shm"
  # Waits up to 30 s for a lock the server holds; the backup restarts itself if the server writes
  # meanwhile, so what it ends with is one consistent state.
  if ! err=$(sqlite3 -cmd ".timeout 30000" "$source" ".backup '$writing'" 2>&1); then
    message="sqlite3 .backup of $source failed: $err"
    return 1
  fi
  # The copy keeps the source's WAL mode; a standalone file has no -wal beside it.
  if ! sqlite3 "$writing" "PRAGMA journal_mode=DELETE;" >/dev/null 2>&1; then
    message="could not finish the copy of $source"
    return 1
  fi
  suffix=""
  check=$(sqlite3 "$writing" "PRAGMA integrity_check;" 2>&1) || true
  case "$check" in
  *libsql_*)
    # A schema with libSQL's own functions: stock SQLite cannot parse it, libSQL checks it.
    check=$("$checker" "$writing" 2>&1) || true
    suffix=.libsql
    ;;
  esac
  rm -f "$writing-wal" "$writing-shm"
  if [ "$check" != ok ]; then
    message="the copy of $source failed integrity_check: $(echo "$check" | head -n 3 | tr '\n' ' ')"
    return 1
  fi
  copied="$dest/$(basename "$source")$suffix-$2"
  chmod 600 "$writing"
  mv -f "$writing" "$copied"
  writing=""
  log "$copied: $(wc -c <"$copied" | tr -d ' ') bytes, integrity ok"
}

# prune <name>: keep the newest $keep of <name>-YYYY-MM-DD and of <name>.libsql-YYYY-MM-DD.
prune() {
  for family in "$1" "$1.libsql"; do
    # shellcheck disable=SC2010 # the names are this script's own <name>-YYYY-MM-DD
    ls -1 "$dest" | grep -E "^$(echo "$family" | sed 's/\./\\./g')-[0-9]{4}-[0-9]{2}-[0-9]{2}\$" | sort -r |
      tail -n +"$((keep + 1))" | while read -r old; do
      rm -f "${dest:?}/$old"
      log "pruned $old"
    done
  done
}

# Runs one snapshot, records its outcome in .last-status, returns its exit code.
run_once() {
  if snapshot; then rc=0; else rc=1; fi
  if [ -d "$dest" ]; then
    printf '%s %s %s\n' "$(date +%s)" "$rc" "$(printf '%s' "${message:-ok}" | tr '\r\n' '  ' | cut -c1-400)" \
      >"$dest/.last-status" 2>/dev/null && chmod 644 "$dest/.last-status" 2>/dev/null || true
  fi
  if [ "$rc" = 0 ]; then
    echo "${message%%; WARNING*}"
  else
    log "FAILED: $message"
  fi
  return "$rc"
}

trap cleanup EXIT
case "${1:-}" in
'')
  trap 'cleanup; exit 143' TERM INT
  run_once
  ;;
--at)
  at=${2:-}
  case "$at" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *)
    echo "usage: factory-snapshot --at HH:MM (00:00 to 23:59), not '$at'" >&2
    exit 2
    ;;
  esac
  # A stop ends the wait at once; one that comes during a snapshot takes effect when sqlite3 returns,
  # and the trap removes the lock and the partial copy.
  trap 'cleanup; exit 0' TERM INT
  log "taking a snapshot of $db every day at $at ($(date +%Z)) into $dest, keeping $keep"
  while :; do
    now=$(date +%s)
    next=$(date -d "$at" +%s)
    [ "$next" -gt "$now" ] || next=$(date -d "tomorrow $at" +%s)
    sleep $((next - now)) &
    wait $! || true
    run_once >/dev/null || true
  done
  ;;
-h | --help)
  sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'
  ;;
*)
  echo "usage: factory-snapshot [--at HH:MM]" >&2
  exit 2
  ;;
esac
