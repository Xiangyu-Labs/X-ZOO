# shellcheck shell=bash
# The readiness gate. Sourced by `shop upgrade` and `shop rollback`, which end
# on it, and by `shop status`, which runs it on its own.
#
# `/healthz` at the edge is shallow by design: nginx answering for itself, so a
# slow app cannot take the edge's own liveness probe down with it. A *container*
# healthcheck must stay shallow too — a probe that opens a PostgreSQL connection
# restarts the container when the database blips (apps/web/src/server/health.ts
# says so in as many words).
#
# The deep check has an HTTP surface: the edge proxies `/readyz` to the
# app's `/api/v1/readyz`, which answers database, Redis, schema and
# worker heartbeat, or 503 with `{code, message, details: {checks}}` and nothing
# else. Nothing restarts a container on that answer; a *release* is gated on it,
# here. Five things, in the order they fail usefully:
#
#   1. every service Compose started reports healthy;
#   2. the edge answers /healthz for itself;
#   3. the edge answers /readyz through to the app, with every check ok;
#   4. the schema is migrated — the migrations table is populated and the
#      tables the release needs exist;
#   5. the worker heartbeat is fresh.
#
# 3 overlaps 4 and 5, and they stay anyway. 4 is per release: the tables come
# from `NEXT_READINESS_TABLES` and the app cannot know which ones this release
# needs. 5 read through `compose exec` is the second vantage point OPS-002 asks
# for — the app reads the heartbeat over the same `REDIS_URL` the worker writes
# it with, so it would find the key even on the wrong Redis. And an endpoint
# that reports itself ready is worth checking against the database directly at
# the moment of a release.
#
# 3 is also the only one of the five that works before the stack is reachable
# by any other means, and the only one an uptime monitor or a load balancer can
# run — which is why `/readyz` is exposed over HTTP at all.

# Tables every release needs before it can serve. Deliberately a small,
# hand-picked list rather than "count the tables": a count passes on a schema
# that migrated halfway.
READINESS_TABLES="${NEXT_READINESS_TABLES:-config_values admins roles orders products}"

readiness_services_healthy() {
  local service container status failed=0
  for service in $APP_SERVICES $DATA_SERVICES; do
    container="$(compose ps -q "$service" 2>/dev/null || true)"
    if [ -z "$container" ]; then
      warn "readiness: $service is not running"
      failed=1
      continue
    fi
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    case "$status" in
      healthy | running) ;;
      *)
        warn "readiness: $service is $status"
        failed=1
        ;;
    esac
  done
  return "$failed"
}

# Probed from inside the edge container. That is not a shortcut around the
# published port — it is the same request the container healthcheck makes, and
# it works identically whether the port is on loopback or behind Traefik. The
# published port is checked separately below.
readiness_edge_probe() {
  local path="$1" body
  if ! body="$(compose exec -T edge wget -q -O - "http://127.0.0.1$path" 2>/dev/null)"; then
    warn "readiness: the edge did not answer $path"
    return 1
  fi
  printf '%s' "$body"
}

# The deep check, over HTTP, exactly as a monitor or a load balancer would ask
# it. A 503 carries `details.checks`, which names the dependency that is down —
# so this prints the reason rather than "it did not answer".
#
# It needs `curl`, because the only HTTP client in the edge image is busybox
# `wget`, which prints nothing at all on a non-2xx response: the one case whose
# body is worth reading. Without curl the fallback below can still tell ready
# from not ready, and says that is all it can do.
readiness_readyz_over_http() {
  local bind response status body
  bind="$(setting NEXT_EDGE_BIND)"
  bind="${bind:-127.0.0.1:8080}"

  if ! command -v curl >/dev/null 2>&1; then
    body="$(readiness_edge_probe /readyz)" || {
      warn 'readiness: /readyz did not answer 2xx; install curl on this host to see which check failed'
      return 1
    }
    case "$body" in
      *'"status":"ok"'*) ;;
      *)
        warn 'readiness: /readyz did not report ok'
        return 1
        ;;
    esac
    return 0
  fi

  # A 502 or 504 is nginx saying it cannot reach `web` *yet*: right after a
  # recreate, the edge's resolver (valid=2s) and its keepalive pool can still
  # point at the container that was just replaced, and the containers'
  # 15-second healthchecks are too coarse to see a window that short. So those
  # — and a port that does not answer at all — are retried for a short while.
  # A 503 is not: that is the app itself naming a dependency that is down, and
  # it is the answer the gate exists to act on.
  local deadline=$((SECONDS + ${NEXT_READINESS_SETTLE_SECONDS:-30}))
  while :; do
    # `-w` appends the status on its own line, so one request yields both
    # without a temporary file holding a body nobody asked to keep.
    if response="$(curl -sS --max-time 15 -w '\n%{http_code}' "http://$bind/readyz" 2>&1)"; then
      status="${response##*$'\n'}"
      body="${response%$'\n'*}"
    else
      status='000'
      body="$response"
    fi
    case "$status" in
      000 | 502 | 504) ;;
      *) break ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      if [ "$status" = '000' ]; then
        warn "readiness: the published port $bind did not answer /readyz"
        warn "  $body"
        return 1
      fi
      break
    fi
    say "readiness: /readyz answered $status — the edge cannot reach web yet; retrying"
    sleep 3
  done
  if [ "$status" != '200' ]; then
    warn "readiness: /readyz answered $status"
    # The body is `{code, message, details: {checks}}` and carries no host and
    # no credential by contract, so printing it whole is safe and is the fastest
    # route to the dependency that is actually down.
    warn "  $body"
    return 1
  fi
  case "$body" in
    *'"status":"ok"'*) ;;
    *)
      warn 'readiness: /readyz answered 200 without status ok'
      return 1
      ;;
  esac
  say 'readiness: /readyz reports every dependency ok'
}

readiness_http() {
  local body bind
  body="$(readiness_edge_probe /healthz)" || return 1
  case "$body" in
    ok*) ;;
    *)
      warn "readiness: /healthz answered '$body'"
      return 1
      ;;
  esac

  # And once through the published port, so a stack that is healthy inside and
  # unreachable outside is not called ready.
  bind="$(setting NEXT_EDGE_BIND)"
  bind="${bind:-127.0.0.1:8080}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 10 "http://$bind/healthz" -o /dev/null || {
      warn "readiness: the published port $bind did not answer /healthz"
      return 1
    }
  fi

  readiness_readyz_over_http || return 1
}

readiness_schema() {
  local applied table present
  applied="$(psql_q "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || true)"
  if [ -z "$applied" ] || [ "$applied" -lt 1 ] 2>/dev/null; then
    warn "readiness: no migration has been applied (drizzle.__drizzle_migrations is empty or absent)"
    return 1
  fi
  for table in $READINESS_TABLES; do
    present="$(psql_q "select to_regclass('public.$table') is not null" 2>/dev/null || true)"
    if [ "$present" != 't' ]; then
      warn "readiness: the table '$table' is missing"
      return 1
    fi
  done
  say "readiness: $applied migration(s) applied, required tables present"
}

readiness_worker() {
  # The image's own probe, so the gate and the container healthcheck cannot
  # disagree about what a live worker is.
  if ! compose exec -T worker node /app/healthcheck.mjs; then
    warn 'readiness: the worker heartbeat is missing or stale'
    return 1
  fi
}

readiness_gate() {
  local failed=0
  readiness_services_healthy || failed=1
  readiness_http || failed=1
  readiness_schema || failed=1
  readiness_worker || failed=1
  if [ "$failed" -ne 0 ]; then
    warn 'readiness gate: FAILED'
    return 1
  fi
  say 'readiness gate: passed'
}
