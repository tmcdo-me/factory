#!/bin/sh
# An online, consistent copy of the Factory server's database, taken while the server runs, onto the
# same volume: installed in the image as /usr/local/bin/factory-snapshot. See fork/deploy/README.md.
#
#   factory-snapshot              take one now (what a backup runs before it copies the volume:
#                                 `docker compose exec factory factory-snapshot`)
#   factory-snapshot --at HH:MM   take one every day at HH:MM (local time, TZ) and keep running: the
#                                 compose stack's `factory-snapshot` sidecar
#
# It writes $FACTORY_BACKUP_DIR/mastra.db-YYYY-MM-DD (today's date; a second run the same day replaces
# it), made with SQLite's online backup API (`sqlite3 .backup`), so it is consistent while the server
# writes: a plain copy of the live file can be torn, or miss what is still in mastra.db-wal. The copy
# is a standalone SQLite file (rollback journal, no -wal) that passed `PRAGMA integrity_check` before it
# took the name, so the newest dated copy is always a whole, checked database. mastra-vectors.db beside
# the database, when there is one, gets the same. Only the newest $FACTORY_BACKUP_KEEP dated copies stay.
# Every run records `<epoch> <exit code> <message>` in $FACTORY_BACKUP_DIR/.last-status.
#
# Never in it: secrets. The environment (FACTORY_CREDENTIAL_ENCRYPTION_KEY above all: without it the
# integration secrets in the database cannot be read) belongs in the operator's vault.
#
# Settings (environment, as the image sets them):
#   MASTRA_DB_PATH, MASTRA_APP_DATA_DIR   the database, as the server reads them (/data/app/mastra.db)
#   FACTORY_BACKUP_DIR                    where copies go (default /data/backups)
#   FACTORY_BACKUP_KEEP                   dated copies kept (default 7)
# Prints the copy's path; exits non-zero on any failure (in --at mode it logs and tries again tomorrow).
set -eu
# The copies hold conversations and encrypted secrets: only the server's user reads them.
umask 077

dest=${FACTORY_BACKUP_DIR:-/data/backups}
keep=${FACTORY_BACKUP_KEEP:-7}
db=${MASTRA_DB_PATH:-}
[ -n "$db" ] || db="${MASTRA_APP_DATA_DIR:-/data/app}/mastra.db"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) factory-snapshot: $*" >&2; }

# One snapshot; on failure prints why on stdout's last line and returns non-zero.
snapshot() {
  [ -f "$db" ] || { echo "no database at $db"; return 1; }
  case "$keep" in '' | *[!0-9]* | 0) echo "FACTORY_BACKUP_KEEP must be a positive number, not '$keep'"; return 1 ;; esac
  if ! { mkdir -p "$dest" && chmod 700 "$dest"; }; then
    echo "cannot create $dest"
    return 1
  fi

  lock="$dest/.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    # A lock left by a run that died (older than 6 hours) is cleared; a live one stops this run.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +360 2>/dev/null)" ] && rmdir "$lock" && mkdir "$lock"; then
      :
    else
      echo "another snapshot is running ($lock)"
      return 1
    fi
  fi
  day=$(date +%Y-%m-%d)
  status=0
  for source in "$db" "$(dirname "$db")/mastra-vectors.db"; do
    [ -f "$source" ] || continue
    if ! copy_one "$source" "$dest/$(basename "$source")-$day"; then
      status=1
      break
    fi
  done
  rmdir "$lock" 2>/dev/null || true
  [ "$status" = 0 ] || return 1
  prune "$(basename "$db")"
  [ -f "$(dirname "$db")/mastra-vectors.db" ] && prune mastra-vectors.db
  echo "$dest/$(basename "$db")-$day"
}

# copy_one <live database> <final name>: online backup to a temporary name, made standalone and
# checked, then renamed over the final name in one step.
copy_one() {
  source=$1
  final=$2
  partial="$final.partial"
  rm -f "$partial" "$partial-journal" "$partial-wal" "$partial-shm"
  # Waits up to 30 s for a lock the server holds; the backup restarts itself if the server writes
  # meanwhile, so what it ends with is one consistent state.
  if ! err=$(sqlite3 -cmd ".timeout 30000" "$source" ".backup '$partial'" 2>&1); then
    rm -f "$partial"
    echo "sqlite3 .backup of $source failed: $err"
    return 1
  fi
  # The copy keeps the source's WAL mode; a standalone file has no -wal beside it.
  if ! sqlite3 "$partial" "PRAGMA journal_mode=DELETE;" >/dev/null 2>&1; then
    rm -f "$partial" "$partial-wal" "$partial-shm"
    echo "could not finish the copy of $source"
    return 1
  fi
  check=$(sqlite3 "$partial" "PRAGMA integrity_check;" 2>&1) || check="could not check: $check"
  rm -f "$partial-wal" "$partial-shm"
  if [ "$check" != ok ]; then
    rm -f "$partial"
    echo "the copy of $source failed integrity_check: $(echo "$check" | head -n 3 | tr '\n' ' ')"
    return 1
  fi
  chmod 600 "$partial"
  mv -f "$partial" "$final"
  log "$final: $(wc -c <"$final" | tr -d ' ') bytes, integrity ok"
}

# prune <name>: keep the newest $keep of <name>-YYYY-MM-DD (the names sort by date).
prune() {
  # shellcheck disable=SC2010 # the names are this script's own <name>-YYYY-MM-DD
  ls -1 "$dest" | grep -E "^$1-[0-9]{4}-[0-9]{2}-[0-9]{2}\$" | sort -r | tail -n +"$((keep + 1))" |
    while read -r old; do
      rm -f "${dest:?}/$old"
      log "pruned $old"
    done
}

# Runs one snapshot, records its outcome in .last-status, returns its exit code.
run_once() {
  if out=$(snapshot); then
    rc=0
  else
    rc=$?
  fi
  message=$(printf '%s' "$out" | tail -n 1)
  if [ -d "$dest" ]; then
    printf '%s %s %s\n' "$(date +%s)" "$rc" "$(printf '%s' "${message:-ok}" | tr '\r\n' '  ' | cut -c1-400)" \
      >"$dest/.last-status" 2>/dev/null || true
  fi
  if [ "$rc" = 0 ]; then
    echo "$message"
  else
    log "FAILED: $message"
  fi
  return "$rc"
}

case "${1:-}" in
'')
  run_once
  ;;
--at)
  at=${2:-}
  case "$at" in
  [0-2][0-9]:[0-5][0-9]) ;;
  *)
    echo "usage: factory-snapshot --at HH:MM" >&2
    exit 2
    ;;
  esac
  # A stop (SIGTERM) ends the wait at once instead of after the grace period.
  trap 'exit 0' TERM INT
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
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  ;;
*)
  echo "usage: factory-snapshot [--at HH:MM]" >&2
  exit 2
  ;;
esac
