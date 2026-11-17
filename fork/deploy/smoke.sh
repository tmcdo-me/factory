#!/usr/bin/env bash
# `check && say || fail` is the pattern throughout (say always succeeds); tmpfs options hold commas;
# cleanup runs from the EXIT trap.
# shellcheck disable=SC2015,SC2001,SC2054,SC2329
# End-to-end check of a built Factory image, with a throwaway volume and environment (no real secret,
# no real OIDC issuer, a dummy Sprites token: nothing it starts reaches anything). Run by
# .github/workflows/fork-image.yml after the build; also by hand on a machine with Docker:
#
#   fork/deploy/smoke.sh <image> [port]
#
# It checks: the server boots and answers /auth/me (200), serves the UI, runs as `node` under tini and
# goes healthy; the guard refuses the local sandbox provider; a fresh root-owned /data is given to node;
# factory-snapshot, exec'd as root, runs as node and leaves only node's files, for a plain database and
# for a libSQL vector index; the snapshot sidecar loop starts and stops on SIGTERM; `docker stop` runs
# Factory's shutdown and exits 0 within the grace period. Prints the image's size. Cleans up after itself.
set -euo pipefail

image=${1:?usage: smoke.sh <image> [port]}
port=${2:-5877}
name=factory-smoke-$$
volume=factory-smoke-$$
work=$(mktemp -d)
env_file="$work/env"
failed=0

say() { echo "smoke: $*"; }
fail() {
  echo "smoke: FAILED: $*" >&2
  failed=1
}
cleanup() {
  docker rm -f "$name" "$name-fresh" "$name-snapshot" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

random() { head -c 32 /dev/urandom | base64; }
cat >"$env_file" <<EOF
TZ=America/Chicago
MASTRACODE_PUBLIC_URL=http://localhost:$port
OIDC_ISSUER=http://127.0.0.1:5879
OIDC_CLIENT_ID=smoke
OIDC_CLIENT_SECRET=smoke-secret
FACTORY_SESSION_SECRET=$(random)
FACTORY_CREDENTIAL_ENCRYPTION_KEY=$(random)
SPRITES_TOKEN=dummy-sprites-token
FACTORY_SPRITES_PREFIX=factory-smoke
EOF

# The compose example's hardening: read-only root, memory /tmp and $HOME, only the capabilities the
# entrypoint needs to hand /data to node.
hardening=(--read-only --tmpfs /tmp:uid=1000,gid=1000,mode=0700 --tmpfs /home/node:uid=1000,gid=1000,mode=0700
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true)

wait_for_auth_me() {
  local url=$1 deadline=$((SECONDS + 120)) code=000
  while [ $SECONDS -lt $deadline ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url/auth/me" || true)
    [ "$code" = 200 ] && return 0
    sleep 1
  done
  echo "$code"
  return 1
}

size=$(docker image inspect -f '{{.Size}}' "$image")
say "image $image: $((size / 1048576)) MB uncompressed"

# --- boot ---------------------------------------------------------------------------------------
docker volume create "$volume" >/dev/null
docker run -d --name "$name" -p "127.0.0.1:$port:5873" --env-file "$env_file" -v "$volume:/data" \
  "${hardening[@]}" --stop-timeout 60 "$image" >/dev/null
started=$SECONDS
if wait_for_auth_me "http://127.0.0.1:$port" >/dev/null; then
  say "/auth/me 200 after $((SECONDS - started)) s: $(curl -s "http://127.0.0.1:$port/auth/me")"
else
  fail "/auth/me did not answer 200 within 120 s"
  docker logs "$name" 2>&1 | tail -40 >&2
fi
title=$(curl -s -H 'Accept: text/html' "http://127.0.0.1:$port/signin" | grep -o '<title>[^<]*</title>' || true)
[ "$title" = "<title>Mastra Factory</title>" ] && say "UI: $title" || fail "the sign-in page is not the Factory UI ($title)"
asset=$(curl -s -H 'Accept: text/html' "http://127.0.0.1:$port/signin" | grep -oE '/assets/index-[^"]+\.js' | head -n 1 || true)
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$asset")
[ -n "$asset" ] && [ "$code" = 200 ] && say "UI asset $asset: 200" || fail "UI asset '$asset' answered $code"
docker exec "$name" factory-healthcheck && say "health check: ok" || fail "factory-healthcheck failed"
users=$(docker top "$name" -o pid,uid,args | tail -n +2)
echo "$users" | sed 's/^/  /'
# tini (PID 1), varlock and the server: all node's.
[ "$(echo "$users" | awk '$2 != 1000' | wc -l)" = 0 ] && [ "$(echo "$users" | wc -l)" -ge 3 ] &&
  say "every process runs as uid 1000, tini included" || fail "a process runs as another user"
[ "$(docker exec "$name" stat -c %U /data/app/mastra.db)" = node ] && say "database owned by node" ||
  fail "the database is not node's"

# --- snapshot, exec'd as root ---------------------------------------------------------------------
if out=$(docker exec "$name" factory-snapshot 2>&1); then
  say "factory-snapshot: $(echo "$out" | tail -n 1)"
else
  fail "factory-snapshot: $out"
fi
# A libSQL vector index, which stock sqlite3 cannot check: made with the server's own @libsql/client.
docker exec -u node -w /app/stores/libsql "$name" node -e "
  const { createClient } = require('@libsql/client');
  (async () => {
    const c = createClient({ url: 'file:/data/app/mastra-vectors.db' });
    await c.execute('CREATE TABLE v (id TEXT PRIMARY KEY, embedding F32_BLOB(3))');
    await c.execute('CREATE INDEX v_idx ON v (libsql_vector_idx(embedding))');
    for (let i = 0; i < 20; i++) await c.execute({ sql: 'INSERT INTO v VALUES (?, vector32(?))', args: [String(i), JSON.stringify([i, i + 1, i + 2])] });
    c.close();
  })().catch(e => { console.error(e); process.exit(1); });
" || fail "could not make a vector index"
if out=$(docker exec "$name" factory-snapshot 2>&1); then
  echo "$out" | sed 's/^/  /'
  echo "$out" | grep -q 'mastra-vectors.db.libsql-.*integrity ok' && say "vector index copied and checked by libSQL" ||
    fail "no checked copy of the vector index"
else
  fail "factory-snapshot with a vector index: $out"
fi
# As node: root in this container has no capability to read node's 0700/0711 directories.
listing=$(docker exec -u node "$name" find /data -printf '%u %m %p\n')
echo "$listing" | sed 's/^/  /'
[ "$(echo "$listing" | awk '$1 != "node"' | wc -l)" = 0 ] && say "everything on /data is node's" ||
  fail "files on /data that are not node's"
docker exec "$name" sh -c 'cut -d" " -f2 /data/backups/.last-status' | grep -qx 0 && say ".last-status: 0" ||
  fail ".last-status is not 0"

# --- the snapshot sidecar loop -------------------------------------------------------------------
docker run -d --name "$name-snapshot" -e TZ=America/Chicago -v "$volume:/data" "${hardening[@]}" \
  "$image" factory-snapshot --at 03:30 >/dev/null
sleep 3
docker logs "$name-snapshot" 2>&1 | sed 's/^/  /'
docker stop -t 30 "$name-snapshot" >/dev/null
sidecar_exit=$(docker inspect -f '{{.State.ExitCode}}' "$name-snapshot")
if [ "$sidecar_exit" = 0 ]; then
  say "sidecar stopped cleanly"
else
  fail "the sidecar exited $sidecar_exit on SIGTERM"
  docker logs "$name-snapshot" 2>&1 | tail -20 >&2
fi

# --- the guard -----------------------------------------------------------------------------------
if out=$(docker run --rm --env-file "$env_file" -e FACTORY_SANDBOX_PROVIDER=local --tmpfs /data \
  "${hardening[@]}" "$image" 2>&1); then
  fail "the server started with FACTORY_SANDBOX_PROVIDER=local"
else
  echo "$out" | grep -q 'FACTORY_DEPLOYMENT=container runs every session on Fly.io Sprites' &&
    say "guard: refuses FACTORY_SANDBOX_PROVIDER=local" || fail "refused, but not by the guard: $(echo "$out" | tail -5)"
fi

# --- a fresh, root-owned volume ------------------------------------------------------------------
docker run -d --name "$name-fresh" -p "127.0.0.1:$((port + 1)):5873" --env-file "$env_file" \
  --mount type=tmpfs,destination=/data "${hardening[@]}" "$image" >/dev/null
if wait_for_auth_me "http://127.0.0.1:$((port + 1))" >/dev/null; then
  owners=$(docker exec "$name-fresh" stat -c '%U %n' /data /data/app /data/backups)
  [ "$(echo "$owners" | awk '$1 != "node"' | wc -l)" = 0 ] && say "a root-owned /data was given to node" ||
    fail "a fresh /data is not node's: $owners"
else
  fail "the server did not start on a fresh root-owned /data"
  docker logs "$name-fresh" 2>&1 | tail -20 >&2
fi
docker rm -f "$name-fresh" >/dev/null

# --- shutdown ------------------------------------------------------------------------------------
say "before the stop: $(docker inspect -f '{{.State.Status}} (exit {{.State.ExitCode}}, started {{.State.StartedAt}})' "$name")"
stop_started=$SECONDS
docker stop -t 60 "$name" >/dev/null
took=$((SECONDS - stop_started))
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
docker logs "$name" 2>&1 | grep -q '\[factory\] the server is shutting down; stopping Factory first' &&
  say "shutdown: Factory stopped first" || fail "no Factory shutdown line in the log"
if [ "$exit_code" = 0 ] && [ "$took" -lt 60 ]; then
  say "docker stop: exit 0 after $took s"
else
  fail "docker stop: exit $exit_code after $took s"
  docker logs "$name" 2>&1 | tail -40 >&2
fi

if [ "$failed" = 0 ]; then say "all checks passed"; else say "some checks failed"; fi
exit "$failed"
