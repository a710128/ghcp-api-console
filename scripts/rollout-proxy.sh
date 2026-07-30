#!/usr/bin/env bash
# Zero-downtime rolling update for the proxy service.
#
# Plain `docker compose up` recreates all proxy replicas at once, causing a brief
# window with no healthy replica. Swarm's deploy.update_config is ignored outside
# Swarm mode. This script instead replaces replicas one at a time:
#
#   for each old replica:
#     scale up one extra replica on the freshly built image
#     wait until every non-old replica is healthy
#     stop + remove that one old replica
#
# proxy-lb re-resolves replica IPs via Docker DNS, so at least one healthy replica
# serves traffic throughout. proxy is stateless and account init is serialized by a
# PostgreSQL advisory lock, so running an extra replica transiently is safe.
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE=proxy
BASE_REPLICAS="${BASE_REPLICAS:-2}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

log() { echo "[rollout-proxy] $*"; }

replica_ids() { docker compose ps -q "$SERVICE"; }

# Fail unless the given container reports healthy within HEALTH_TIMEOUT seconds.
wait_healthy() {
  local cid="$1" waited=0
  while :; do
    local status
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo gone)
    case "$status" in
      healthy) return 0 ;;
      gone) log "container $cid disappeared while waiting"; return 1 ;;
    esac
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      log "timeout: $cid still '$status' after ${HEALTH_TIMEOUT}s"; return 1
    fi
    sleep 2; waited=$((waited + 2))
  done
}

log "building fresh $SERVICE image"
docker compose build "$SERVICE"

# Snapshot the replicas that exist now; these are the ones to retire.
mapfile -t OLD < <(replica_ids)
if [ "${#OLD[@]}" -eq 0 ]; then
  log "no running $SERVICE replicas; doing a plain up"
  docker compose up -d "$SERVICE"
  exit 0
fi
log "replacing ${#OLD[@]} old replica(s): ${OLD[*]}"

target="$BASE_REPLICAS"
for old in "${OLD[@]}"; do
  target=$((target + 1))
  log "scaling $SERVICE up to $target (new replica on fresh image)"
  docker compose up -d --no-deps --no-recreate --scale "$SERVICE=$target" "$SERVICE"

  # Wait for every replica except the old ones we haven't retired yet. In practice
  # the newest one is what just came up; requiring all-but-retiring to be healthy
  # is a strict, safe gate.
  for cid in $(replica_ids); do
    skip=""
    for o in "${OLD[@]}"; do [ "$cid" = "$o" ] && skip=1 && break; done
    [ -n "$skip" ] && continue
    log "waiting for new replica $cid to become healthy"
    wait_healthy "$cid" || { log "ABORT: new replica unhealthy, leaving old replica $old running"; exit 1; }
  done

  log "retiring old replica $old (graceful stop, up to stop_grace_period)"
  docker stop "$old" >/dev/null
  docker rm "$old" >/dev/null
  target=$((target - 1))
done

# Re-assert the declared replica count so compose's state matches the file.
log "normalizing $SERVICE to $BASE_REPLICAS replicas"
docker compose up -d --no-deps --no-recreate --scale "$SERVICE=$BASE_REPLICAS" "$SERVICE"

log "done. current replicas:"
docker compose ps "$SERVICE"
