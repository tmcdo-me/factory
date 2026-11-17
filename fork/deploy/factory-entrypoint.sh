#!/bin/sh
# The image's entrypoint (installed as /usr/local/bin/factory-entrypoint), PID 1 for a moment: makes sure
# the data volume belongs to the server's user, then replaces itself with tini and the command, as that
# user. See fork/deploy/README.md.
#
# A fresh volume is root's: a Fly volume, or a bind mount Docker created, hides the image's own /data.
# Started as root, this gives /data to `node` only when it, /data/app or /data/backups is not node's
# already (so a restart does not walk the whole volume), then replaces itself, under setpriv as node,
# with a shell that creates the two subdirectories if missing and execs the rest (tini, then the
# command). tini is then PID 1 as node and forwards SIGTERM to the command, so Factory's shutdown runs;
# a root tini could not signal node's processes, the container having no CAP_KILL. Started as any other user (`user:` in compose), it only runs the command.
# As root it needs CAP_CHOWN (only to fix ownership) and CAP_SETUID and CAP_SETGID.
set -eu

data=/data
if [ "$(id -u)" = 0 ]; then
  owner="$(id -u node):$(id -g node)"
  for dir in "$data" "$data/app" "$data/backups"; do
    if [ -e "$dir" ] && [ "$(stat -c %u:%g "$dir")" != "$owner" ]; then
      echo "factory-entrypoint: $dir is not owned by node ($owner); giving $data to node" >&2
      chown -R node:node "$data"
      break
    fi
  done
  # As node from here: the subdirectories a fresh volume lacks, then the command.
  # shellcheck disable=SC2016 # expanded by the inner sh
  exec setpriv --reuid=node --regid=node --init-groups -- \
    sh -c 'mkdir -p "$0/app" "$0/backups" && exec "$@"' "$data" "$@"
fi
mkdir -p "$data/app" "$data/backups"
exec "$@"
