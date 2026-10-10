#!/usr/bin/env bash
# The deploy drill: every claim `shop` and `ship.sh` make, proved against real
# containers, on this machine, in one command.
#
#   deploy/rehearsal/drill.sh [--list] [--shards] [--shard <name>] [--only <substring>]
#                             [--parallel [--jobs N]]
#                             [--keep] [--no-build --web REF --worker REF --edge REF]
#
# Each case has a stable id, so a rule in `docs/invariants.md` can point at
# something re-runnable rather than at a paragraph:
#
#   deploy/rehearsal/drill.sh::upgrade/failed-migration-ends-on-previous
#
# Everything is disposable and namespaced. The drill runs in its own Compose
# project (`x-zoo-drill`), against its own generated settings file in a
# temporary directory, publishing on a free loopback port, pushing to a
# throwaway registry container it starts itself. It never reads, writes or
# touches `deploy/deployment.env`, the `x-zoo` project, or any host
# but this one. The overlay case puts the edge on a stand-in network with a
# stand-in label, never on `server-internal-net` with Traefik's labels: on the
# production host that would hand the live domain's routers a second backend.
#
# Why a local registry rather than `NEXT_ALLOW_LOCAL_IMAGES=1`: the digest path
# is the part worth drilling. Pinning, pulling, and reading back the digest a
# container is actually running are three separate mechanisms, and a drill that
# bypasses them proves the scripts work in the one mode production never uses.
#
# The `ship/` cases ship the *committed* tree (`git archive HEAD`), as a real
# release does, into a directory under $TMPDIR with `SHIP_HOST=local`: no SSH,
# a stand-in `gh` that answers for CI, and the images published to the
# throwaway registry under `sha-<HEAD>`. Commit before drilling a change to
# what ships. The site is never checked from outside: the drill's settings name
# no public host.
#
# Shards: the cases fall into groups that each start from their own stack and
# leave nothing the other groups read (`--shards` names them, `--shard <name>`
# runs one). CI runs one shard per runner, in parallel, against images built
# once (`--no-build`); without `--shard` every case runs in order, as before.
# Every case is in exactly one shard: the check below refuses a case with none,
# and the `pipeline` guard holds that the workflow runs every shard.
#
# `--parallel` does what CI does on one machine: it builds the three images once
# (the three builds side by side), then runs every shard at the same time, each
# as its own `--shard <name> --no-build` child with a log of its own, and
# reports them together. A shard's project, containers, registry, network,
# derived image tags and ports are named after it (`x-zoo-drill-<shard>`), so
# the shards cannot collide with each other or with a plain run
# (`x-zoo-drill`). `--jobs N` caps how many run at once on a busy machine.
#
# Passwords are generated per run into a mode-600 file under $TMPDIR and
# deleted on teardown. No credential is ever passed in argv — the rule the real
# scripts keep, kept here too, so the drill is not the exception that teaches
# the habit.
#
# Exit codes: 0 every selected case passed · 1 a case failed · 2 misuse ·
#             3 the environment could not be built (nothing was proved).
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="$(cd "$here/.." && pwd)"
repo_root="$(cd "$deploy_dir/.." && pwd)"

only=''
shard=''
keep=0
build=1
web_src=''
worker_src=''
edge_src=''
list_only=0
list_shards=0
parallel=0
jobs=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list) list_only=1 ;;
    --shards) list_shards=1 ;;
    --shard)
      shard="${2:?--shard needs a name}"
      shift
      ;;
    --shard=*) shard="${1#*=}" ;;
    --only)
      only="${2:?--only needs a substring}"
      shift
      ;;
    --only=*) only="${1#*=}" ;;
    --keep) keep=1 ;;
    --parallel) parallel=1 ;;
    --jobs)
      jobs="${2:?--jobs needs a number}"
      shift
      ;;
    --jobs=*) jobs="${1#*=}" ;;
    --no-build) build=0 ;;
    --web)
      web_src="${2:?--web needs an image}"
      shift
      ;;
    --worker)
      worker_src="${2:?--worker needs an image}"
      shift
      ;;
    --edge)
      edge_src="${2:?--edge needs an image}"
      shift
      ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

# The order matters: a case that needs a deployed stack is written after the
# case that deploys one, and `--only` never reorders them.
CASE_IDS=(
  static/healthcheck-per-service
  static/memory-budget
  static/no-secrets-in-repo
  static/traefik-overlay-resolves
  cli/help-lists-commands
  overlay/refuses-missing-file
  upgrade/refuses-moving-tag
  upgrade/requires-all-three-candidates
  upgrade/first-deploy
  upgrade/dry-run-changes-nothing
  edge/proxies-every-page-route
  edge/serves-verification-files
  edge/cdn-pull-gets-uploads-only
  backup/verifies-restore
  backup/verifies-beside-live-writes
  backup/refuses-tampered-dump
  backup/refuses-truncated-dump
  upgrade/failed-migration-ends-on-previous
  upgrade/unhealthy-worker-ends-on-previous
  upgrade/readiness-gate-ends-on-previous
  upgrade/deploys-and-records-rollback-target
  rollback/refuses-unavailable-target
  rollback/last-upgrade-returns-previous
  overlay/upgrade-and-rollback-keep-overlay
  status/reports-the-release
  upgrade/no-migration-keeps-serving
  upgrade/edge-follows-a-recreated-web
  upgrade/config-only-stops-nothing
  upgrade/pending-migration-stops-writers
  ship/refuses-red-ci
  ship/dry-run-changes-nothing
  ship/into-a-fresh-dir
  ship/removes-what-it-no-longer-ships
  ship/refuses-while-another-release-runs
  ship/failed-upgrade-puts-the-files-back
  ship/forwards-host-commands
)
CASE_FNS=(
  case_healthcheck_per_service
  case_memory_budget
  case_no_secrets_in_repo
  case_traefik_overlay_resolves
  case_help_lists_commands
  case_overlay_refuses_missing
  case_refuses_moving_tag
  case_requires_all_three
  case_first_deploy
  case_dry_run
  case_edge_proxies_every_page
  case_edge_serves_verification_files
  case_edge_cdn_pull_gets_uploads_only
  case_backup_verifies_restore
  case_backup_beside_live_writes
  case_backup_refuses_tampered_dump
  case_backup_refuses_truncated_dump
  case_failed_migration
  case_unhealthy_worker
  case_readiness_gate
  case_deploys_v2
  case_rollback_refuses_unavailable
  case_rollback_last_upgrade
  case_overlay_kept
  case_status_reports
  case_no_migration_keeps_serving
  case_edge_follows_web
  case_config_only
  case_pending_migration
  case_ship_refuses_red_ci
  case_ship_dry_run
  case_ship_fresh_dir
  case_ship_removes
  case_ship_locked
  case_ship_failed_upgrade
  case_ship_forwards
)

# The group each case runs in, one entry per case above. A group is a chain: a
# case that needs the stack another case left (v2 deployed, a dump taken) sits
# in that case's group, after it. Which cases a group holds is decided by what
# they read and by cost: `unhealthy` is the one case that waits out the real
# worker healthcheck (about 2.5 minutes), so it is a runner of its own.
CASE_SHARDS=(
  release # static/healthcheck-per-service
  release # static/memory-budget
  release # static/no-secrets-in-repo
  release # static/traefik-overlay-resolves
  release # cli/help-lists-commands
  release # overlay/refuses-missing-file
  release # upgrade/refuses-moving-tag
  release # upgrade/requires-all-three-candidates
  release # upgrade/first-deploy
  release # upgrade/dry-run-changes-nothing
  release # edge/proxies-every-page-route
  release # edge/serves-verification-files
  release # edge/cdn-pull-gets-uploads-only
  release # backup/verifies-restore
  release # backup/verifies-beside-live-writes
  release # backup/refuses-tampered-dump
  release # backup/refuses-truncated-dump
  failures # upgrade/failed-migration-ends-on-previous
  unhealthy # upgrade/unhealthy-worker-ends-on-previous
  failures # upgrade/readiness-gate-ends-on-previous
  release # upgrade/deploys-and-records-rollback-target
  release # rollback/refuses-unavailable-target
  release # rollback/last-upgrade-returns-previous
  release # overlay/upgrade-and-rollback-keep-overlay
  release # status/reports-the-release
  serving # upgrade/no-migration-keeps-serving
  serving # upgrade/edge-follows-a-recreated-web
  serving # upgrade/config-only-stops-nothing
  serving # upgrade/pending-migration-stops-writers
  ship # ship/refuses-red-ci
  ship # ship/dry-run-changes-nothing
  ship # ship/into-a-fresh-dir
  ship # ship/removes-what-it-no-longer-ships
  ship # ship/refuses-while-another-release-runs
  ship # ship/failed-upgrade-puts-the-files-back
  ship # ship/forwards-host-commands
)

# The groups, in the order they first appear.
shard_names() {
  local seen=' ' name
  for name in "${CASE_SHARDS[@]}"; do
    case "$seen" in *" $name "*) continue ;; esac
    seen+="$name "
    printf '%s\n' "$name"
  done
}

if [ "${#CASE_IDS[@]}" -ne "${#CASE_FNS[@]}" ] || [ "${#CASE_IDS[@]}" -ne "${#CASE_SHARDS[@]}" ]; then
  printf 'drill.sh: CASE_IDS (%s), CASE_FNS (%s) and CASE_SHARDS (%s) must list the same cases\n' \
    "${#CASE_IDS[@]}" "${#CASE_FNS[@]}" "${#CASE_SHARDS[@]}" >&2
  exit 2
fi

if [ "$list_shards" -eq 1 ]; then
  shard_names
  exit 0
fi
if [ -n "$shard" ]; then
  shard_list="$(shard_names | paste -sd' ' -)"
  case " $shard_list " in
    *" $shard "*) ;;
    *)
      printf 'unknown shard: %s (one of: %s)\n' "$shard" "$shard_list" >&2
      exit 2
      ;;
  esac
fi
if [ "$parallel" -eq 1 ]; then
  if [ -n "$shard" ] || [ -n "$only" ]; then
    printf -- '--parallel runs every shard; it takes neither --shard nor --only\n' >&2
    exit 2
  fi
  case "$jobs" in
    '' | *[!0-9]*)
      printf -- '--jobs needs a whole number\n' >&2
      exit 2
      ;;
  esac
fi
if [ "$list_only" -eq 1 ]; then
  for index in "${!CASE_IDS[@]}"; do
    if [ -z "$shard" ] || [ "${CASE_SHARDS[$index]}" = "$shard" ]; then
      printf '%s\n' "${CASE_IDS[$index]}"
    fi
  done
  exit 0
fi

# --- environment ---------------------------------------------------------------

command -v docker >/dev/null 2>&1 || {
  printf 'docker is required\n' >&2
  exit 3
}
docker info >/dev/null 2>&1 || {
  printf 'the docker daemon is not reachable\n' >&2
  exit 3
}

# --- every shard at once (--parallel) -----------------------------------------

# Builds the images once, then starts one child per shard and waits for all of
# them. Nothing here touches Docker beyond the builds: each child sets up and
# tears down its own stack, exactly as a CI runner does.
run_parallel() {
  local logdir role file pid code shard_name status=0 started
  local -a shards=() pids=() live=() extra=()
  local -A pid_of=() code_of=() began=() took=()
  logdir="$(mktemp -d "${TMPDIR:-/tmp}/x-zoo-drill-logs.XXXXXX")"
  mapfile -t shards < <(shard_names)
  [ "$jobs" -gt 0 ] || jobs="${#shards[@]}"
  [ "$keep" -eq 0 ] || extra+=(--keep)

  # Stop every child (each tears its own stack down on the way out) if this run
  # is interrupted.
  trap 'printf "\ninterrupted: stopping the shards\n" >&2
    for pid in "${pid_of[@]}"; do kill -TERM "$pid" 2>/dev/null; done
    wait; exit 130' INT TERM

  if [ "$build" -eq 1 ]; then
    printf '\n=== building the three images (logs in %s)\n' "$logdir"
    for role in web worker edge; do
      case "$role" in
        web) file="$repo_root/docker/web.Dockerfile" ;;
        worker) file="$repo_root/docker/worker.Dockerfile" ;;
        edge) file="$repo_root/docker/edge/Dockerfile" ;;
      esac
      docker build -f "$file" -t "x-zoo-$role:drill" "$repo_root" >"$logdir/build-$role.log" 2>&1 &
      pids+=("$!")
    done
    for pid in "${pids[@]}"; do
      wait "$pid" || {
        printf 'an image did not build; see %s/build-*.log\n' "$logdir" >&2
        exit 3
      }
    done
    web_src="${web_src:-x-zoo-web:drill}"
    worker_src="${worker_src:-x-zoo-worker:drill}"
    edge_src="${edge_src:-x-zoo-edge:drill}"
  elif [ -z "$web_src" ] || [ -z "$worker_src" ] || [ -z "$edge_src" ]; then
    printf -- '--no-build needs --web, --worker and --edge\n' >&2
    exit 2
  fi

  # Waits for whichever shard ends first and records it, so a shard's time is
  # when it ended, not when an earlier one in the list did.
  reap_one() {
    # Only the shards still running: `wait -n` on one already reaped would
    # return at once.
    live=()
    for started in "${!pid_of[@]}"; do
      [ -n "${code_of[$started]:-}" ] || live+=("${pid_of[$started]}")
    done
    code=0
    wait -n -p pid "${live[@]}" || code=$?
    for started in "${!pid_of[@]}"; do
      if [ "${pid_of[$started]}" = "$pid" ]; then
        code_of[$started]="$code"
        took[$started]=$((SECONDS - began[$started]))
        printf '  %s finished (exit %s, %ss)\n' "$started" "$code" "${took[$started]}"
      fi
    done
  }

  printf '\n=== running %s shards, %s at a time (logs in %s)\n' "${#shards[@]}" "$jobs" "$logdir"
  local running=0
  for shard_name in "${shards[@]}"; do
    while [ "$running" -ge "$jobs" ]; do
      reap_one
      running=$((running - 1))
    done
    "$0" --shard "$shard_name" --no-build --web "$web_src" --worker "$worker_src" --edge "$edge_src" \
      "${extra[@]}" >"$logdir/$shard_name.log" 2>&1 &
    pid_of[$shard_name]="$!"
    began[$shard_name]="$SECONDS"
    running=$((running + 1))
    printf '  %s started\n' "$shard_name"
  done
  while [ "$running" -gt 0 ]; do
    reap_one
    running=$((running - 1))
  done
  trap - INT TERM

  printf '\n=== results\n'
  for shard_name in "${shards[@]}"; do
    code="${code_of[$shard_name]}"
    if [ "$code" -eq 0 ]; then
      printf 'ok    %-10s %ss  %s\n' "$shard_name" "${took[$shard_name]}" \
        "$(grep -E '^[0-9]+ passed, ' "$logdir/$shard_name.log" | tail -n1)"
    else
      printf 'FAIL  %-10s %ss  exit %s, log %s\n' "$shard_name" "${took[$shard_name]}" "$code" \
        "$logdir/$shard_name.log"
      # A case failure outranks an environment failure, which outranks misuse.
      if [ "$code" -eq 1 ] || [ "$status" -eq 0 ]; then status="$code"; fi
    fi
  done
  for shard_name in "${shards[@]}"; do
    [ "${code_of[$shard_name]}" -ne 0 ] || continue
    printf '\n--- the end of %s\n' "$logdir/$shard_name.log"
    tail -n 40 "$logdir/$shard_name.log"
  done
  return "$status"
}

if [ "$parallel" -eq 1 ]; then
  run_parallel && exit 0
  exit "$?"
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/x-zoo-drill.XXXXXX")"
chmod 700 "$workdir"
mkdir -p "$workdir/ctx"

# Everything this run creates is named after it: `x-zoo-drill`, or
# `x-zoo-drill-<shard>` for one shard, so shards can run side by side
# (`--parallel`). The shard name was checked against the list above, so the
# name can only ever start with `x-zoo-drill`.
drill_name="x-zoo-drill${shard:+-$shard}"
# Local tags for the derived images, per run for the same reason.
image_tag="drill${shard:+-$shard}"
# Each shard looks for its ports from a base of its own, so two shards starting
# at once do not both find the same free port.
shard_index=0
if [ -n "$shard" ]; then
  shard_index="$(shard_names | grep -nxF -- "$shard" | cut -d: -f1)"
fi

export NEXT_PROJECT="$drill_name"
export NEXT_DEPLOYMENT_ENV="$workdir/deployment.env"
# compose.yml pins container names so `docker logs x-zoo-worker` works;
# the prefix is what lets this run beside a real stack instead of colliding
# with it by name.
export NEXT_CONTAINER_PREFIX="$drill_name"
registry_container="$drill_name-registry"
# The stand-in for Traefik's external network, created by the overlay case.
overlay_network="$drill_name-front"

# A free loopback port, found by asking rather than by hoping. Bash's /dev/tcp
# needs no python, no ss and no netcat.
free_port() {
  local port="$1"
  while [ "$port" -lt 65000 ]; do
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || {
      printf '%s\n' "$port"
      return 0
    }
    port=$((port + 1))
  done
  return 1
}

edge_port="$(free_port $((18080 + shard_index * 100)))" || exit 3
registry_port="$(free_port $((15000 + shard_index * 100)))" || exit 3
registry="127.0.0.1:$registry_port"

teardown() {
  local code=$?
  set +e
  if [ "$keep" -eq 1 ]; then
    printf '\n--keep: left behind\n'
    printf '  project:  %s\n' "$NEXT_PROJECT"
    printf '  settings: %s (holds generated passwords)\n' "$NEXT_DEPLOYMENT_ENV"
    printf '  edge:     http://127.0.0.1:%s\n' "$edge_port"
    printf '  registry: %s (container %s)\n' "$registry" "$registry_container"
    return "$code"
  fi
  printf '\ntearing the drill down\n'
  # `down -v` deletes volumes, which is right *here* and wrong anywhere else,
  # so the project name is the drill's own, never `$NEXT_PROJECT`: no
  # environment variable can point this line at `x-zoo`.
  case "$drill_name" in
    x-zoo-drill | x-zoo-drill-*) ;;
    *) return 2 ;;
  esac
  docker compose -p "$drill_name" --project-directory "$deploy_dir" \
    -f "$deploy_dir/compose.yml" --env-file "$NEXT_DEPLOYMENT_ENV" \
    --profile migrate down -v --remove-orphans >/dev/null 2>&1
  docker network rm "$overlay_network" >/dev/null 2>&1
  docker rm -f "$registry_container" >/dev/null 2>&1
  rm -rf "$workdir" # the generated passwords live in here
  return "$code"
}
trap teardown EXIT

# --- settings -------------------------------------------------------------------

secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

pg_password="$(secret)"
redis_password="$(secret)"

umask 077
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pg_password|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$redis_password|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://shop:$pg_password@postgres:5432/shop|" \
  -e "s|^REDIS_URL=.*|REDIS_URL=redis://:$redis_password@redis:6379|" \
  -e "s|^APP_ORIGIN=.*|APP_ORIGIN=http://127.0.0.1:$edge_port|" \
  -e "s|^APP_VERSION=.*|APP_VERSION=drill|" \
  -e "s|^NEXT_EDGE_BIND=.*|NEXT_EDGE_BIND=127.0.0.1:$edge_port|" \
  -e "s|^NEXT_HOST=.*|NEXT_HOST=|" \
  -e "s|^NEXT_BACKUP_DIR=.*|NEXT_BACKUP_DIR=$workdir/backups|" \
  -e "s|^NEXT_DOMAIN_VERIFICATION_DIR=.*|NEXT_DOMAIN_VERIFICATION_DIR=$workdir/domain-verification|" \
  "$deploy_dir/deployment.env.example" >"$NEXT_DEPLOYMENT_ENV"
chmod 600 "$NEXT_DEPLOYMENT_ENV"

# shellcheck source=../lib/common.sh
. "$deploy_dir/lib/common.sh"

# --- images ----------------------------------------------------------------------

step() { printf '\n=== %s\n' "$*"; }

step "starting a throwaway registry on $registry"
docker rm -f "$registry_container" >/dev/null 2>&1 || true
docker run -d --name "$registry_container" -p "$registry:5000" registry:2 >/dev/null ||
  {
    printf 'could not start the registry\n' >&2
    exit 3
  }
for _ in $(seq 1 30); do
  (exec 3<>"/dev/tcp/127.0.0.1/$registry_port") 2>/dev/null && break
  sleep 1
done

if [ "$build" -eq 1 ]; then
  step 'building the three images'
  docker build -f "$repo_root/docker/web.Dockerfile" -t x-zoo-web:drill "$repo_root" || exit 3
  docker build -f "$repo_root/docker/worker.Dockerfile" -t x-zoo-worker:drill "$repo_root" || exit 3
  docker build -f "$repo_root/docker/edge/Dockerfile" -t x-zoo-edge:drill "$repo_root" || exit 3
  web_src="${web_src:-x-zoo-web:drill}"
  worker_src="${worker_src:-x-zoo-worker:drill}"
  edge_src="${edge_src:-x-zoo-edge:drill}"
elif [ -z "$web_src" ] || [ -z "$worker_src" ] || [ -z "$edge_src" ]; then
  printf -- '--no-build needs --web, --worker and --edge\n' >&2
  exit 2
fi

# Pushes an image and returns the immutable reference the registry gave it.
# That reference — never the tag that was pushed — is what the cases deploy,
# which is what `shop upgrade` demands of a real release.
publish() {
  local source="$1" repo="$2" tag="$3" digest
  docker tag "$source" "$registry/$repo:$tag"
  docker push "$registry/$repo:$tag" >/dev/null
  digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$registry/$repo:$tag" |
    grep -F "$registry/$repo@sha256:" | head -n1)"
  [ -n "$digest" ] || {
    printf 'no digest for %s\n' "$repo" >&2
    return 1
  }
  printf '%s\n' "$digest"
}

# The derived images add a layer to a real one. The context is an empty
# directory: none of them copies anything in, and sending the repository would
# cost a gigabyte per build for nothing.
derive() {
  local dockerfile="$1" base="$2" tag="$3"
  shift 3
  docker build -f "$dockerfile" --build-arg "BASE=$base" "$@" -t "$tag" "$workdir/ctx" >/dev/null
}

step 'publishing the release candidates'
web_v1="$(publish "$web_src" x-zoo-web v1)" || exit 3
worker_v1="$(publish "$worker_src" x-zoo-worker v1)" || exit 3
edge_v1="$(publish "$edge_src" x-zoo-edge v1)" || exit 3

derive "$here/relabel.Dockerfile" "$web_src" "x-zoo-web:$image_tag-v2" --build-arg DRILL_VERSION=v2 || exit 3
derive "$here/relabel.Dockerfile" "$worker_src" "x-zoo-worker:$image_tag-v2" --build-arg DRILL_VERSION=v2 || exit 3
derive "$here/relabel.Dockerfile" "$edge_src" "x-zoo-edge:$image_tag-v2" --build-arg DRILL_VERSION=v2 || exit 3
web_v2="$(publish "x-zoo-web:$image_tag-v2" x-zoo-web v2)" || exit 3
worker_v2="$(publish "x-zoo-worker:$image_tag-v2" x-zoo-worker v2)" || exit 3
edge_v2="$(publish "x-zoo-edge:$image_tag-v2" x-zoo-edge v2)" || exit 3

derive "$here/broken-worker.Dockerfile" "$worker_src" "x-zoo-worker:$image_tag-broken" || exit 3
derive "$here/pending-migration.Dockerfile" "$worker_src" "x-zoo-worker:$image_tag-badmigrate" \
  --build-arg MIGRATION_TAG=9000_drill_fails \
  --build-arg 'MIGRATION_SQL=SELECT 1 / 0;' || exit 3
derive "$here/pending-migration.Dockerfile" "$worker_src" "x-zoo-worker:$image_tag-v3" \
  --build-arg MIGRATION_TAG=9000_drill_marker \
  --build-arg 'MIGRATION_SQL=CREATE TABLE "drill_marker" ("id" integer);' || exit 3
worker_broken="$(publish "x-zoo-worker:$image_tag-broken" x-zoo-worker broken)" || exit 3
worker_badmigrate="$(publish "x-zoo-worker:$image_tag-badmigrate" x-zoo-worker badmigrate)" || exit 3
worker_v3="$(publish "x-zoo-worker:$image_tag-v3" x-zoo-worker v3)" || exit 3

say "  web    v1 $web_v1"
say "  web    v2 $web_v2"
say "  worker v1 $worker_v1"
say "  worker v2 $worker_v2"

# --- the harness ------------------------------------------------------------------

passed=0
failed=0
skipped=0
case_failures=0
results=()

note() { printf '    %s\n' "$*"; }

# A case function runs inside `fn || rc=$?`, which suspends `set -e` for its
# whole body — so a failed assertion does not stop it and must not be masked by
# a later one that passes. Every assertion therefore records itself.
check() {
  local what="$1"
  shift
  if "$@"; then
    note "ok: $what"
    return 0
  fi
  note "NOT ok: $what"
  case_failures=$((case_failures + 1))
  return 1
}

# Runs a command expecting a specific exit code, keeping its output for the
# case to grep.
run_expect() {
  local want="$1" log="$2" got=0
  shift 2
  "$@" >"$log" 2>&1 || got=$?
  if [ "$got" -ne "$want" ]; then
    note "expected exit $want, got $got; last lines of $log:"
    tail -n 8 "$log" | sed 's/^/      /'
    case_failures=$((case_failures + 1))
    return 1
  fi
  return 0
}

shop() { "$deploy_dir/shop" "$@"; }
upgrade() { shop upgrade "$@"; }
rollback() { shop rollback "$@"; }
backup() { shop backup "$@"; }

# What `deployment.env` pins, and what the containers are actually running. The
# drill asserts on both every time: a rollback that edited the file but left the
# old container up, or restarted a container but left the file pointing at the
# failed release, is a rollback that surprises the next person to run
# `docker compose up`.
pinned() { setting "NEXT_$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')_IMAGE"; }
running() {
  local captured
  captured="$(running_image_ref "$1")" || return 1
  printf '%s\n' "${captured%% *}"
}
on_release() {
  local service="$1" want="$2"
  [ "$(pinned "$service")" = "$want" ] && [ "$(running "$service")" = "$want" ]
}

selected() {
  [ -z "$shard" ] || [ "$2" = "$shard" ] || return 1
  [ -z "$only" ] && return 0
  case "$1" in *"$only"*) return 0 ;; esac
  return 1
}

run_case() {
  local id="$1" fn="$2" group="$3" rc=0
  selected "$id" "$group" || return 0
  printf '\n--- %s\n' "$id"
  case_failures=0
  "$fn" || rc=$?
  if [ "$rc" -eq 77 ]; then
    skipped=$((skipped + 1))
    results+=("SKIP $id")
  elif [ "$rc" -ne 0 ] || [ "$case_failures" -ne 0 ]; then
    failed=$((failed + 1))
    results+=("FAIL $id")
  else
    passed=$((passed + 1))
    results+=("PASS $id")
  fi
}

# The stack has to exist before most cases mean anything. Whichever case needs
# it first brings it up; `upgrade/first-deploy` is the case that asserts the
# bringing-up worked.
deployed=0
ensure_deployed() {
  case "$deployed" in
    1) return 0 ;;
    -1) return 1 ;;
  esac
  deployed=-1
  run_expect 0 "$workdir/first-deploy.log" \
    upgrade --first-deploy --app-version drill-v1 \
    --web "$web_v1" --worker "$worker_v1" --edge "$edge_v1" || return 1
  deployed=1
}

# --- static cases --------------------------------------------------------------

have_python() { command -v python3 >/dev/null 2>&1; }
compose_json() { compose --profile migrate config --format json; }

case_healthcheck_per_service() {
  have_python || {
    note 'python3 is not installed'
    return 77
  }
  compose_json >"$workdir/compose.json" || return 1
  python3 - "$workdir/compose.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
missing = []
for name, service in sorted(config['services'].items()):
    # `migrate` is a one-shot that exits; a healthcheck on it has nothing to
    # report. Everything that stays up has to say whether it is working.
    if name == 'migrate':
        continue
    check = service.get('healthcheck')
    if not check or check.get('disable'):
        missing.append(name)
print('  services checked:', ', '.join(n for n in sorted(config['services']) if n != 'migrate'))
if missing:
    print('  NO healthcheck:', ', '.join(missing))
    sys.exit(1)
PY
}

case_memory_budget() {
  have_python || {
    note 'python3 is not installed'
    return 77
  }
  compose_json >"$workdir/compose.json" || return 1
  python3 - "$workdir/compose.json" <<'PY'
import json, re, sys
config = json.load(open(sys.argv[1]))
CAP = 1600 * 1024 * 1024   # the host's budget for the stack: every role at once, under 1.6 GB

def limit(service):
    value = service.get('deploy', {}).get('resources', {}).get('limits', {}).get('memory')
    if value is None:
        return None
    if isinstance(value, int):
        return value
    unit = {'b': 1, 'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3}
    match = re.fullmatch(r'(\d+)\s*([bkmgBKMG]?)b?', str(value).strip())
    if not match:
        raise SystemExit(f'  unparsable memory limit: {value!r}')
    return int(match.group(1)) * unit[(match.group(2) or 'b').lower()]

ONE_SHOT_CAP = 2048 * 1024 * 1024   # the same, with the seed running beside them
failures, total, one_shot = [], 0, 0
for name, service in sorted(config['services'].items()):
    value = limit(service)
    if value is None:
        failures.append(f'{name} declares no memory limit')
        continue
    # `migrate` is a one-shot. A release with nothing to migrate runs its seed
    # beside the live stack, so it is counted once more on top, separately.
    if name != 'migrate':
        total += value
    else:
        one_shot = value
    print(f'  {name:<9} {value // 1024 // 1024:>4} MiB')
    # V8 sizes its heap from the *host's* memory, not the cgroup's, so a node
    # container with no explicit heap cap is OOM killed with no diagnostic.
    options = (service.get('environment') or {}).get('NODE_OPTIONS') or ''
    if name in ('web', 'worker', 'migrate') and '--max-old-space-size' not in options:
        failures.append(f'{name} runs node without --max-old-space-size')
print(f'  {"total":<9} {total // 1024 // 1024:>4} MiB of {CAP // 1024 // 1024} MiB')
print(f'  {"+ seed":<9} {(total + one_shot) // 1024 // 1024:>4} MiB of {ONE_SHOT_CAP // 1024 // 1024} MiB')
if total > CAP:
    failures.append(f'the long-running services total {total // 1024 // 1024} MiB')
if total + one_shot > ONE_SHOT_CAP:
    failures.append(f'with the one-shot beside them they total {(total + one_shot) // 1024 // 1024} MiB')
for failure in failures:
    print('  NOT ok:', failure)
sys.exit(1 if failures else 0)
PY
}

# Nothing tracked may carry a credential. The check reads the *tracked* files
# rather than the working tree, so a local `deployment.env` — gitignored, and
# generated by this very script elsewhere — cannot make it pass or fail for the
# wrong reason.
case_no_secrets_in_repo() {
  local tracked offenders
  tracked="$(git -C "$repo_root" ls-files 'deploy' 'docker' 2>/dev/null || true)"
  [ -n "$tracked" ] || {
    note 'not a git checkout'
    return 77
  }
  offenders="$(printf '%s\n' "$tracked" | while read -r file; do
    grep -InE '^(POSTGRES_PASSWORD|REDIS_PASSWORD)=' "$repo_root/$file" 2>/dev/null |
      grep -v 'CHANGE-ME' | sed "s|^|$file:|" || true
  done)"
  if [ -n "$offenders" ]; then
    printf '%s\n' "$offenders" | sed 's/^/      /'
    case_failures=$((case_failures + 1))
  else
    note 'ok: no tracked file under deploy or docker sets a password'
  fi
  check 'deployment.env is gitignored' \
    git -C "$repo_root" check-ignore -q deploy/deployment.env
  check 'ship.local.env is gitignored' \
    git -C "$repo_root" check-ignore -q deploy/ship.local.env
}

# One entry point on the host, and it says what it does.
case_help_lists_commands() {
  local command
  run_expect 0 "$workdir/help.log" shop help || return 1
  for command in upgrade rollback backup status resolve compose hostname; do
    check "shop help lists $command" grep -qE "^  $command " "$workdir/help.log"
  done
  run_expect 2 "$workdir/help-unknown.log" shop readyz || return 1
  check 'an unknown command is refused and the list printed' grep -q '^usage: shop' "$workdir/help-unknown.log"
}

# The real Traefik overlay, merged the way every script merges it: named by
# its relative file name in the settings and resolved against the deploy
# directory. `compose config` neither creates nor joins a network, so this
# reads the result without the edge going anywhere near `server-internal-net`.
# With the key empty, as in the drill's own settings, the edge must have
# neither the network nor a Traefik label.
case_traefik_overlay_resolves() {
  have_python || {
    note 'python3 is not installed'
    return 77
  }
  local traefik_env="$workdir/traefik.env"
  sed \
    -e 's|^NEXT_COMPOSE_OVERLAYS=.*|NEXT_COMPOSE_OVERLAYS=compose.traefik.yml|' \
    -e 's|^NEXT_HOST=.*|NEXT_HOST=drill.invalid|' \
    -e 's|^NEXT_EDGE_TRUSTED_PROXIES=.*|NEXT_EDGE_TRUSTED_PROXIES=192.0.2.0/24|' \
    "$NEXT_DEPLOYMENT_ENV" >"$traefik_env"
  chmod 600 "$traefik_env"
  if ! (
    settings="$traefik_env"
    require_settings
    compose config --format json
  ) >"$workdir/traefik.json" 2>"$workdir/traefik.err"; then
    sed 's/^/      /' "$workdir/traefik.err"
    return 1
  fi
  compose config --format json >"$workdir/plain.json" || return 1
  python3 - "$workdir/traefik.json" "$workdir/plain.json" <<'PY'
import json, sys
overlaid = json.load(open(sys.argv[1]))['services']['edge']
plain = json.load(open(sys.argv[2]))['services']['edge']
failures = []
if 'server-internal-net' not in (overlaid.get('networks') or {}):
    failures.append('with the overlay the edge is not on server-internal-net')
if 'default' not in (overlaid.get('networks') or {}):
    failures.append('with the overlay the edge left the default network')
labels = overlaid.get('labels') or {}
if labels.get('traefik.enable') != 'true':
    failures.append('with the overlay the edge has no traefik.enable=true')
if labels.get('traefik.http.routers.x-zoo-https.rule') != 'Host(`drill.invalid`)':
    failures.append('with the overlay the https router is not Host(NEXT_HOST)')
# The session cookies are Secure: an http:// page that is served, not
# redirected, signs people in and then forgets them.
if labels.get('traefik.http.routers.x-zoo-http.middlewares') != 'x-zoo-https-redirect' \
        or labels.get('traefik.http.middlewares.x-zoo-https-redirect.redirectscheme.scheme') != 'https':
    failures.append('with the overlay the http router does not redirect to https')
# The router uses Traefik's default TLS options, which allow the TLS 1.2 that
# WeChat on iOS needs; options of its own bring back 421 Misdirected Request
# (README.md, "The Traefik overlay").
if labels.get('traefik.http.routers.x-zoo-https.tls.options') != 'default':
    failures.append('with the overlay the https router does not use the default TLS options')
if 'server-internal-net' in (plain.get('networks') or {}):
    failures.append('without the overlay the edge is on server-internal-net')
if any(key.startswith('traefik.') for key in (plain.get('labels') or {})):
    failures.append('without the overlay the edge carries a traefik label')
for failure in failures:
    print('    NOT ok:', failure)
if not failures:
    print('    ok: the overlay adds the network and the routers; without it the edge has neither')
sys.exit(1 if failures else 0)
PY
}

# An overlay the settings name but the directory lacks stops every script
# before it touches anything, rather than surfacing later as "the edge is not
# running".
case_overlay_refuses_missing() {
  local saved="$workdir/settings.before-missing-overlay"
  cp -p "$NEXT_DEPLOYMENT_ENV" "$saved"
  set_setting NEXT_COMPOSE_OVERLAYS 'compose.yml, compose.not-there.yml'
  if run_expect 1 "$workdir/overlay-missing-status.log" shop status; then
    check 'shop status names the missing file' \
      grep -q 'compose.not-there.yml, which does not exist' "$workdir/overlay-missing-status.log"
  fi
  if run_expect 1 "$workdir/overlay-missing-upgrade.log" \
    upgrade --dry-run --web "$web_v1" --worker "$worker_v1" --edge "$edge_v1"; then
    check 'shop upgrade names the missing file' \
      grep -q 'compose.not-there.yml, which does not exist' "$workdir/overlay-missing-upgrade.log"
  fi
  cp -p "$saved" "$NEXT_DEPLOYMENT_ENV"
}

# --- upgrade cases ---------------------------------------------------------------

case_refuses_moving_tag() {
  # A tag can be repointed between the run that passed acceptance and the
  # deploy, which makes the rollback target unidentifiable.
  run_expect 1 "$workdir/moving-tag.log" \
    upgrade --first-deploy --web "$registry/x-zoo-web:v1" \
    --worker "$worker_v1" --edge "$edge_v1" || return 1
  check 'the refusal names digest pinning' \
    grep -q 'pinned by digest' "$workdir/moving-tag.log"
}

# The three roles are three different images, so a release must name all
# three: a `web` that moved while `worker` did not is a web talking to a worker
# built against a different contract.
case_requires_all_three() {
  local role
  for role in web worker edge; do
    local args=()
    [ "$role" = 'web' ] || args+=(--web "$web_v1")
    [ "$role" = 'worker' ] || args+=(--worker "$worker_v1")
    [ "$role" = 'edge' ] || args+=(--edge "$edge_v1")
    run_expect 1 "$workdir/missing-$role.log" upgrade "${args[@]}" || continue
    check "omitting --$role is refused by name" \
      grep -q "no candidate given for $role" "$workdir/missing-$role.log"
  done
}

case_first_deploy() {
  ensure_deployed || return 1
  check 'the readiness gate passed' grep -q 'readiness gate: passed' "$workdir/first-deploy.log"
  check 'the migrations ran' grep -q 'migration(s) applied' "$workdir/first-deploy.log"
  check 'web is on v1' on_release web "$web_v1"
  check 'worker is on v1' on_release worker "$worker_v1"
  check 'edge is on v1' on_release edge "$edge_v1"
  check 'the edge answers /healthz on the published port' \
    curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:$edge_port/healthz"
  check 'the edge answers /readyz through to the app' \
    curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:$edge_port/readyz"
}

case_dry_run() {
  ensure_deployed || return 1
  local before
  before="$(cat "$NEXT_DEPLOYMENT_ENV")"
  run_expect 0 "$workdir/dry-run.log" \
    upgrade --dry-run --web "$web_v2" --worker "$worker_v2" --edge "$edge_v2" || return 1
  check 'it says it changed nothing' grep -q 'no migration ran' "$workdir/dry-run.log"
  check 'it asked the candidate and found nothing to migrate' \
    grep -q 'the release would stop nothing' "$workdir/dry-run.log"
  check 'the settings are untouched' [ "$before" = "$(cat "$NEXT_DEPLOYMENT_ENV")" ]
  check 'the stack is still on v1' on_release web "$web_v1"
}

# --- the edge -------------------------------------------------------------------------

# `/admin/(shell)/orders/[id]/page.tsx`, relative to the app directory, is
# `/admin/orders/drill-sample`. Fails for a file under a private folder, which
# is not a route.
route_url() {
  local directory="${1%/*}" segment url=''
  local -a segments
  IFS='/' read -r -a segments <<<"${directory#/}"
  for segment in "${segments[@]}"; do
    case "$segment" in
      '') ;;
      _*) return 1 ;;
      '('*')' | @*) ;;
      '[[...'*']]') ;;
      '['*']') url+='/drill-sample' ;;
      *) url+="/$segment" ;;
    esac
  done
  printf '%s\n' "${url:-/}"
}

# The edge redirects any path it does not proxy to the landing page at `/`, so
# a Next page left out of `nginx.conf` does not 404: it quietly turns into a
# 302 to `/`. Every page route — `/` included, which must be answered by `web`
# itself — and one route handler per top-level path is requested through the
# real edge, and none may come back as that redirect. The icons are not page
# files, so they are checked as the browser finds them: `/favicon.ico`, and
# every icon link on the landing page and the admin's login page.
case_edge_proxies_every_page() {
  ensure_deployed || return 1
  local app="$repo_root/apps/web/app" file url prefix response status location
  local checked=0 handler_prefixes=' ' landing="http://127.0.0.1:$edge_port/"
  [ -d "$app" ] || {
    note "no Next app at $app"
    return 77
  }
  # What "not proxied" looks like, proved on a path no route has (an old H5
  # link): a 302 whose Location resolves to `/`. `%{redirect_url}` is the
  # Location resolved against the request, so `Location: /` reads as
  # `$landing`.
  response="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' \
    "http://127.0.0.1:$edge_port/pages/index/index")" || response=''
  check 'an unknown path is redirected to the landing page' [ "$response" = "302 $landing" ]
  check 'the redirect is relative (Location: /)' \
    sh -c "curl -sS --max-time 10 -o /dev/null -D - 'http://127.0.0.1:$edge_port/pages/index/index' |
      tr -d '\\r' | grep -qix 'location: /'"
  while IFS= read -r file; do
    url="$(route_url "${file#"$app"}")" || continue
    # Only reached through `next.config.ts`'s fallback rewrite, never by its own
    # path; what it answers is checked below, on an API path nothing serves.
    [ "$url" = '/api-not-found' ] && continue
    case "${file##*/}" in
      route.*)
        prefix="${url#/}"
        prefix="${prefix%%/*}"
        case "$handler_prefixes" in *" $prefix "*) continue ;; esac
        handler_prefixes+="$prefix "
        ;;
    esac
    checked=$((checked + 1))
    response="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code} %{redirect_url}' \
      "http://127.0.0.1:$edge_port$url" 2>/dev/null || true)"
    status="${response%% *}"
    location="${response#* }"
    if [ -z "$status" ] || [ "$status" = '000' ]; then
      note "NOT ok: $url did not answer (${file#"$repo_root/"})"
      case_failures=$((case_failures + 1))
    elif [ "$status" = '302' ] && [ "$location" = "$landing" ]; then
      note "NOT ok: $url is redirected to / by the edge, not answered by web (${file#"$repo_root/"})"
      case_failures=$((case_failures + 1))
    fi
  done < <(find "$app" -type f -regextype posix-extended \
    -regex '.*/(page|route)\.(tsx|ts|jsx|js|mdx)' | sort)
  check "$checked route(s) reach web through the edge" [ "$checked" -gt 0 ]
  check 'an API path no route serves is a JSON 404 from web' \
    sh -c "curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{content_type}' \
      'http://127.0.0.1:$edge_port/api/v1/drill-no-such-route' | grep -q '^404 application/json'"

  check '/favicon.ico is an image from web' edge_serves_image /favicon.ico
  local page href links
  for page in / /admin/login; do
    links="$(curl -fsS --max-time 30 "http://127.0.0.1:$edge_port$page" 2>/dev/null |
      grep -oiE '<link[^>]*rel="(shortcut )?(icon|apple-touch-icon)"[^>]*>' |
      sed -nE 's/.*href="([^"]*)".*/\1/p' | sed 's/&amp;/\&/g')" || links=''
    check "$page links an icon" [ -n "$links" ]
    while IFS= read -r href; do
      [ -n "$href" ] || continue
      case "$href" in /*) ;; *) href="/${href#*://*/}" ;; esac
      check "$page's icon $href is an image from web" edge_serves_image "$href"
    done <<<"$links"
  done
}

# Whether text $2 has a line that is $1, ignoring case.
has_line() { printf '%s\n' "$2" | grep -qix -- "$1"; }

# 200 and an `image/…` type through the edge: neither the redirect to `/`
# (a 302) nor the landing page itself (HTML).
edge_serves_image() {
  local response
  response="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{content_type}' \
    "http://127.0.0.1:$edge_port$1" 2>/dev/null)" || return 1
  case "$response" in '200 image/'*) return 0 ;; esac
  note "$1 answered '$response'"
  return 1
}

# The WeChat domain-verification files: `/<name>.txt` at the root comes from the
# read-only mount (`NEXT_DOMAIN_VERIFICATION_DIR`, which this drill points into
# its own workdir), byte for byte; a name that is not there is a 404, not the
# landing-page redirect; nothing outside the plain-name pattern reaches it.
# `/robots.txt` is the one root-level `.txt` it never serves: `web` answers it,
# even with a `robots.txt` placed in the directory.
case_edge_serves_verification_files() {
  ensure_deployed || return 1
  local dir edge_id name="drill_${RANDOM}${RANDOM}" body base="http://127.0.0.1:$edge_port"
  dir="$(verification_dir)"
  check 'shop upgrade created the verification directory, mode 755' \
    [ "$(stat -c '%a' "$dir" 2>/dev/null)" = '755' ]
  body="drill verification $name"
  printf '%s' "$body" >"$dir/$name.txt"
  chmod 644 "$dir/$name.txt"
  check 'a placed file is served as is' \
    [ "$(curl -fsS --max-time 10 "$base/$name.txt")" = "$body" ]
  check 'it is served as text/plain' \
    sh -c "curl -fsS --max-time 10 -o /dev/null -w '%{content_type}' '$base/$name.txt' | grep -qi '^text/plain'"
  check 'a missing file is a 404' \
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base/${name}-missing.txt")" = '404' ]
  check 'a nested .txt is not served from the directory' \
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base/x/$name.txt")" = '302' ]
  printf 'drill placed robots\n' >"$dir/robots.txt"
  chmod 644 "$dir/robots.txt"
  body="$(curl -fsS --max-time 10 "$base/robots.txt" 2>/dev/null)" || body=''
  # The placed file has no `Disallow` line: finding one proves `web` answered.
  check '/robots.txt comes from web (Disallow: /), not the directory' \
    has_line 'disallow: /' "$body"
  check '/robots.txt is text/plain' \
    sh -c "curl -fsS --max-time 10 -o /dev/null -w '%{content_type}' '$base/robots.txt' | grep -qi '^text/plain'"
  rm -f "$dir/robots.txt"
  # `docker exec` runs as root, so only the read-only mount can refuse this.
  edge_id="$(compose ps -q edge)"
  if docker exec "$edge_id" touch /srv/domain-verification/drill-write 2>/dev/null; then
    note 'NOT ok: the edge can write the verification directory (mount is not read-only)'
    case_failures=$((case_failures + 1))
    rm -f "$dir/drill-write"
  else
    note 'ok: the edge cannot write the verification directory'
  fi
  rm -f "$dir/$name.txt"
}

# The image CDN pulls with `X-Shop-Via: cdn` (存储设置 › 图片 CDN 域名) and must get
# `/uploads/` and nothing else, or its hostname is a second copy of the admin.
# A missing upload tells the two 404s apart: only the uploads location sends
# the sandbox CSP.
case_edge_cdn_pull_gets_uploads_only() {
  ensure_deployed || return 1
  local base="http://127.0.0.1:$edge_port" via='X-Shop-Via: cdn' missing="/uploads/drill-${RANDOM}${RANDOM}.jpg"
  check 'without the header, /api/v1/health reaches web' \
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base/api/v1/health")" = '200' ]
  check 'a CDN pull of /api/v1/health is a 404' \
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "$via" "$base/api/v1/health")" = '404' ]
  check 'a CDN pull of /admin is a 404' \
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "$via" "$base/admin")" = '404' ]
  check 'a CDN pull of / is a 404, not the landing page' \
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "$via" "$base/")" = '404' ]
  check 'a CDN pull cannot climb out of /uploads/' \
    [ "$(curl -sS --max-time 10 --path-as-is -o /dev/null -w '%{http_code}' -H "$via" "$base/uploads/../api/v1/health")" = '404' ]
  check 'a CDN pull of /uploads/ reaches the uploads location (its sandbox CSP)' \
    sh -c "curl -sS --max-time 10 -o /dev/null -D - -H '$via' '$base$missing' | grep -qi '^content-security-policy: default-src .none.; sandbox'"
}

# --- backup cases -------------------------------------------------------------------

drill_dump=''

case_backup_verifies_restore() {
  ensure_deployed || return 1
  run_expect 0 "$workdir/backup.log" backup --out "$workdir/drill.sql.gz" || return 1
  drill_dump="$workdir/drill.sql.gz"
  check 'the dump exists and is not empty' test -s "$drill_dump"
  check 'it is mode 600' [ "$(stat -c '%a' "$drill_dump")" = '600' ]
  check 'it was restored and the row counts matched' \
    grep -q 'backup verified' "$workdir/backup.log"
}

# Verification is not "gzip did not error" — it is that the dump restores to
# the same data. A structurally perfect dump that is missing rows is the
# failure mode that costs you the recovery, so the drill removes some and
# requires the verifier to notice.
# `pg_dump` reads one snapshot, so a dump taken while the shop is writing is a
# good dump, but its row counts stop matching the live database a moment
# later. The verification has to prove it against the dump's own snapshot, and
# must not refuse a good dump because somebody placed an order meanwhile.
case_backup_beside_live_writes() {
  ensure_deployed || return 1
  psql_q 'create table if not exists drill_writes (id serial primary key, at timestamptz default now())' \
    >/dev/null || return 1
  local writer rc=0 before after
  before="$(psql_q 'select count(*) from drill_writes')"
  (
    while :; do
      psql_q 'insert into drill_writes default values' >/dev/null 2>&1 || true
      sleep 0.1
    done
  ) &
  writer=$!
  run_expect 0 "$workdir/backup-live.log" backup --out "$workdir/live.sql.gz" || rc=1
  kill "$writer" 2>/dev/null
  wait "$writer" 2>/dev/null || true
  after="$(psql_q 'select count(*) from drill_writes')"
  psql_q 'drop table drill_writes' >/dev/null || true
  [ "$rc" -eq 0 ] || return 1
  check "rows were written while it ran ($before, then $after)" [ "$after" -gt "$before" ]
  check "it verified against the dump's own snapshot" \
    grep -q "counted against the dump's own snapshot" "$workdir/backup-live.log"
}

case_backup_refuses_tampered_dump() {
  [ -n "$drill_dump" ] || {
    note 'no dump from the previous case'
    return 77
  }
  gzip -dc "$drill_dump" >"$workdir/tampered.sql"
  local biggest table rows
  biggest="$(awk '
    /^COPY public\./ { name = $2; rows = 0; next }
    name && $0 == "\\." { print rows, name; name = ""; next }
    name { rows++ }
  ' "$workdir/tampered.sql" | sort -rn | head -n1)"
  rows="${biggest%% *}"
  table="${biggest##* }"
  if [ -z "$table" ] || [ "${rows:-0}" -lt 10 ]; then
    note 'the dump has no table with enough rows to tamper with'
    return 77
  fi
  note "removing 7 of $rows rows from $table"
  awk -v table="$table" '
    $0 ~ "^COPY " table " " { copying = 1; dropped = 0; print; next }
    copying && $0 == "\\." { copying = 0; print; next }
    copying && dropped < 7 { dropped++; next }
    { print }
  ' "$workdir/tampered.sql" | gzip -c >"$workdir/tampered.sql.gz"
  run_expect 1 "$workdir/tampered.log" backup --verify-only "$workdir/tampered.sql.gz" || return 1
  check 'the census diff names the table' \
    grep -q "${table#public.}" "$workdir/tampered.log"
}

case_backup_refuses_truncated_dump() {
  [ -n "$drill_dump" ] || {
    note 'no dump from the previous case'
    return 77
  }
  head -c 4096 "$drill_dump" >"$workdir/truncated.sql.gz"
  run_expect 1 "$workdir/truncated.log" backup --verify-only "$workdir/truncated.sql.gz"
}

# --- the failure paths ----------------------------------------------------------------

# The three ways a release fails, drilled separately: they fail at different
# points, and what the operator has to be told differs at each one.

case_failed_migration() {
  ensure_deployed || return 1
  run_expect 1 "$workdir/bad-migrate.log" \
    upgrade --app-version drill-badmigrate \
    --web "$web_v2" --worker "$worker_badmigrate" --edge "$edge_v2" || return 1
  check 'it found the pending migration' \
    grep -q '1 migration(s) to apply: 9000_drill_fails' "$workdir/bad-migrate.log"
  check 'it stopped the writers to migrate' \
    grep -q 'stopping the application services' "$workdir/bad-migrate.log"
  check 'it says the migration failed' grep -q 'the migration failed' "$workdir/bad-migrate.log"
  check 'a verified dump was taken first' grep -qE '^backup: ' "$workdir/bad-migrate.log"
  check 'it reports the schema may have moved' \
    grep -q 'the database is on the NEW schema' "$workdir/bad-migrate.log"
  check 'web is back on v1' on_release web "$web_v1"
  check 'worker is back on v1' on_release worker "$worker_v1"
  check 'edge is back on v1' on_release edge "$edge_v1"
  check 'the readiness gate still passes' shop status
}

case_unhealthy_worker() {
  ensure_deployed || return 1
  # The candidate starts, stays up and does no work. A crash would be caught by
  # Docker with no probe at all; this is the failure the probe exists for.
  run_expect 1 "$workdir/broken-worker.log" \
    upgrade --app-version drill-broken \
    --web "$web_v2" --worker "$worker_broken" --edge "$edge_v2" || return 1
  check 'it says the stack did not become healthy' \
    grep -q 'did not become healthy' "$workdir/broken-worker.log"
  # Nothing to migrate, so nothing was stopped; the operator is told the schema
  # did not move, which is what makes the previous images a safe place to end.
  check 'it took the path that stops nothing' \
    grep -q 'the release will not stop anything' "$workdir/broken-worker.log"
  check 'it reports the schema did not move' \
    grep -q 'the schema did not move' "$workdir/broken-worker.log"
  check 'web is back on v1' on_release web "$web_v1"
  check 'worker is back on v1' on_release worker "$worker_v1"
  check 'edge is back on v1' on_release edge "$edge_v1"
  check 'the readiness gate still passes' shop status
}

# Every container healthy, both probes answering, and the release still refused
# — because the schema it needs is not there. This is what distinguishes the
# readiness gate from the container healthchecks; without this case the gate
# could be a no-op and nothing here would notice.
case_readiness_gate() {
  ensure_deployed || return 1
  export NEXT_READINESS_TABLES='config_values a_table_this_release_forgot'
  local rc=0
  run_expect 1 "$workdir/gate.log" \
    upgrade --app-version drill-gate \
    --web "$web_v2" --worker "$worker_v2" --edge "$edge_v2" || rc=1
  unset NEXT_READINESS_TABLES
  [ "$rc" -eq 0 ] || return 1
  check 'it names the missing table' \
    grep -q 'a_table_this_release_forgot' "$workdir/gate.log"
  check 'the gate is what refused it' \
    grep -q 'readiness gate did not pass' "$workdir/gate.log"
  check 'web is back on v1' on_release web "$web_v1"
  check 'worker is back on v1' on_release worker "$worker_v1"
  check 'edge is back on v1' on_release edge "$edge_v1"
}

# --- the happy path, and the way back ---------------------------------------------------

case_deploys_v2() {
  ensure_deployed || return 1
  run_expect 0 "$workdir/upgrade-v2.log" \
    upgrade --app-version drill-v2 \
    --web "$web_v2" --worker "$worker_v2" --edge "$edge_v2" || return 1
  check 'web is on v2' on_release web "$web_v2"
  check 'worker is on v2' on_release worker "$worker_v2"
  check 'edge is on v2' on_release edge "$edge_v2"
  check 'it recorded v1 as the rollback target' grep -q "$web_v1" "$workdir/upgrade-v2.log"
  check 'the readiness gate passed' grep -q 'readiness gate: passed' "$workdir/upgrade-v2.log"
}

case_rollback_refuses_unavailable() {
  local before zeros
  before="$(cat "$NEXT_DEPLOYMENT_ENV")"
  zeros="$(printf '0%.0s' $(seq 1 64))"
  run_expect 1 "$workdir/rollback-bad.log" \
    rollback --web "$registry/x-zoo-web@sha256:$zeros" \
    --worker "$worker_v1" --edge "$edge_v1" || return 1
  check 'the settings were not touched' [ "$before" = "$(cat "$NEXT_DEPLOYMENT_ENV")" ]
  check 'the stack is still serving' shop status
}

case_rollback_last_upgrade() {
  # Only meaningful after the successful v2 deploy, which is what wrote the
  # manifest this case reads.
  grep -q "$web_v2" "$NEXT_DEPLOYMENT_ENV" || {
    note 'the stack is not on v2 (select the v2 case too, or run without --only)'
    return 77
  }
  run_expect 0 "$workdir/rollback.log" rollback --last-upgrade || return 1
  check 'web is back on v1' on_release web "$web_v1"
  check 'worker is back on v1' on_release worker "$worker_v1"
  check 'edge is back on v1' on_release edge "$edge_v1"
  check 'the readiness gate passes on the rolled-back stack' shop status
}

# --- the overlay -------------------------------------------------------------------------

edge_on_network() {
  local networks
  networks="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    "$(compose ps -q edge)" 2>/dev/null)" || return 1
  case " $networks " in *" $1 "*) return 0 ;; esac
  return 1
}
edge_off_network() { ! edge_on_network "$1"; }
edge_labelled() {
  [ "$(docker inspect -f '{{index .Config.Labels "x-zoo-drill.overlay"}}' \
    "$(compose ps -q edge)" 2>/dev/null)" = 'applied' ]
}

# Production runs `compose.traefik.yml` on top of `compose.yml`, and an upgrade
# or a rollback that recreated the edge from `compose.yml` alone would take the
# site off the router. With an overlay named in the settings, both have to
# leave the edge on the overlay's network and with its labels. The overlay here
# is a stand-in of the same shape, a second external network and a label, for
# the reason given at the top of this file.
case_overlay_kept() {
  ensure_deployed || return 1
  on_release web "$web_v1" || {
    note 'the stack is not on v1 (run without --only, or together with the v1 cases)'
    return 77
  }
  local overlay="$workdir/compose.drill-front.yml"
  docker network inspect "$overlay_network" >/dev/null 2>&1 ||
    docker network create "$overlay_network" >/dev/null || return 1
  cat >"$overlay" <<YAML
services:
  edge:
    networks:
      - default
      - drill-front
    labels:
      - x-zoo-drill.overlay=applied
networks:
  drill-front:
    name: $overlay_network
    external: true
YAML
  set_setting NEXT_COMPOSE_OVERLAYS "$overlay"

  run_expect 0 "$workdir/overlay-upgrade.log" \
    upgrade --app-version drill-overlay \
    --web "$web_v2" --worker "$worker_v2" --edge "$edge_v2" || return 1
  check 'the upgrade put the edge on v2' on_release edge "$edge_v2"
  check 'after the upgrade the edge is on the overlay network' edge_on_network "$overlay_network"
  check 'after the upgrade the edge is still on the default network' \
    edge_on_network "${NEXT_PROJECT}_default"
  check 'after the upgrade the edge carries the overlay label' edge_labelled

  run_expect 0 "$workdir/overlay-rollback.log" rollback --last-upgrade || return 1
  check 'the rollback put the edge back on v1' on_release edge "$edge_v1"
  check 'after the rollback the edge is on the overlay network' edge_on_network "$overlay_network"
  check 'after the rollback the edge carries the overlay label' edge_labelled
  check 'shop status passes with the overlay' shop status

  # The other way round: with the key emptied, an `up` takes the edge off the
  # overlay. That is how the site leaves the router, and it shows the checks
  # above can fail.
  set_setting NEXT_COMPOSE_OVERLAYS ''
  compose up -d --wait --wait-timeout 180 >/dev/null 2>&1 || true
  check 'with the key emptied, an up takes the edge off the overlay network' \
    edge_off_network "$overlay_network"
  check 'and the stack still serves' shop status
}

# --- what a release that stops nothing looks like from outside -------------------------

# A request every 200 ms through the edge to `web` (`/api/v1/health`, which
# touches nothing behind the app), one `<epoch ms> <status>` line each.
probe_pid=''
probe_log=''
start_probe() {
  probe_log="$workdir/probe-$1.log"
  : >"$probe_log"
  (
    while :; do
      code="$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' \
        "http://127.0.0.1:$edge_port/api/v1/health" 2>/dev/null || true)"
      printf '%s %s\n' "$(date +%s%3N)" "${code:-000}" >>"$probe_log"
      sleep 0.2
    done
  ) &
  probe_pid=$!
  sleep 1
}
stop_probe() {
  kill "$probe_pid" 2>/dev/null
  wait "$probe_pid" 2>/dev/null || true
}
# `<longest gap ms> <failed requests> <requests>`: the gap runs from the last
# answer before a failure to the first answer after it, and is -1 when the
# probe never got an answer again.
probe_summary() {
  awk '
    $2 ~ /^2/ {
      if (failing && seen) { gap = $1 - last_ok; if (gap > longest) longest = gap }
      failing = 0; seen = 1; last_ok = $1; next
    }
    { failing = 1; failed++ }
    END { if (failing) longest = -1; printf "%d %d %d\n", longest, failed, NR }
  ' "$probe_log"
}
container_of() { compose ps -q "$1" 2>/dev/null; }
lacks() { ! grep -q -- "$1" "$2"; }
lacks_fixed() { ! grep -qF -- "$1" "$2"; }
# shellcheck disable=SC2012  # the names are generated by `shop upgrade`.
last_manifest() { ls -t "$workdir"/backups/upgrade-*.manifest | head -n1; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$(container_of "$1")" 2>/dev/null; }

case_status_reports() {
  ensure_deployed || return 1
  run_expect 0 "$workdir/status.log" shop status || return 1
  check 'it names each running image' grep -q "web: $(running web)" "$workdir/status.log"
  check 'it shows the last upgrade manifest' grep -q '^last upgrade: .*upgrade-.*\.manifest' "$workdir/status.log"
  check 'it runs the readiness gate' grep -q 'readiness gate: passed' "$workdir/status.log"
  check 'it prints no password' lacks_fixed "$pg_password" "$workdir/status.log"
  check 'it prints no Redis password' lacks_fixed "$redis_password" "$workdir/status.log"
}

# The point of asking the candidate first: a release with nothing to migrate
# stops nothing. `web` is recreated, so there is a moment with no `web`, and
# the edge is recreated after it; this case measures the longest gap rather
# than pretending it is zero, and holds it to a few seconds (the path that
# stops the writers, measured the same way below, is down for all of it).
case_no_migration_keeps_serving() {
  ensure_deployed || return 1
  on_release web "$web_v1" || {
    note 'the stack is not on v1 (run without --only)'
    return 77
  }
  local rc=0 summary gap failed total
  start_probe no-migration
  run_expect 0 "$workdir/no-migration.log" \
    upgrade --app-version drill-no-migration \
    --web "$web_v2" --worker "$worker_v2" --edge "$edge_v2" || rc=1
  stop_probe
  [ "$rc" -eq 0 ] || return 1
  summary="$(probe_summary)"
  read -r gap failed total <<<"$summary"
  note "measured: $failed of $total requests failed; the longest gap was $gap ms"
  check 'it asked and found nothing to migrate' grep -q 'nothing to migrate' "$workdir/no-migration.log"
  check 'it stopped nothing' lacks 'stopping the application services' "$workdir/no-migration.log"
  check 'it still took and verified a backup' grep -q 'backup verified' "$workdir/no-migration.log"
  check 'it ran the seed beside the live stack' grep -q 'reference seed beside the live stack' "$workdir/no-migration.log"
  check 'web is on v2' on_release web "$web_v2"
  check 'worker is on v2' on_release worker "$worker_v2"
  check 'edge is on v2' on_release edge "$edge_v2"
  check 'web answered again afterwards' [ "$gap" -ge 0 ]
  check 'no gap in answers was longer than 5 s' [ "$gap" -le 5000 ]
}

# Only `web` changes, so Compose recreates only `web`, under a new address,
# beside an edge it does not touch. The edge has to find it: nginx looks the
# name up again rather than keeping the address it started with.
case_edge_follows_web() {
  ensure_deployed || return 1
  on_release edge "$edge_v2" || {
    note 'the stack is not on v2 (run without --only)'
    return 77
  }
  local edge_before rc=0 gap failed total
  edge_before="$(started_at edge)"
  start_probe edge-follows
  run_expect 0 "$workdir/edge-follows.log" \
    upgrade --app-version drill-web-only \
    --web "$web_v1" --worker "$worker_v2" --edge "$edge_v2" || rc=1
  stop_probe
  [ "$rc" -eq 0 ] || return 1
  read -r gap failed total <<<"$(probe_summary)"
  note "measured: $failed of $total requests failed; the longest gap was $gap ms"
  check 'web is on v1' on_release web "$web_v1"
  check 'the edge was neither recreated nor restarted' [ "$(started_at edge)" = "$edge_before" ]
  check 'the edge reaches the new web' \
    curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:$edge_port/api/v1/health"
}

# The same digests, and a Compose file that changed: the http-to-https
# redirect in `compose.traefik.yml` is that kind of release. It goes through
# the same command, stops nothing, and recreates only what the files changed.
case_config_only() {
  ensure_deployed || return 1
  if ! { on_release web "$web_v1" && on_release worker "$worker_v2"; }; then
    note 'the stack is not where the previous case left it (run without --only)'
    return 77
  fi
  local overlay="$workdir/compose.drill-config.yml" web_before worker_before edge_before rc=0
  cat >"$overlay" <<'YAML'
services:
  edge:
    labels:
      - x-zoo-drill.config=applied
YAML
  set_setting NEXT_COMPOSE_OVERLAYS "$overlay"
  web_before="$(container_of web)"
  worker_before="$(container_of worker)"
  edge_before="$(container_of edge)"
  run_expect 0 "$workdir/config-only.log" \
    upgrade --app-version drill-config-only \
    --web "$web_v1" --worker "$worker_v2" --edge "$edge_v2" || rc=1
  set_setting NEXT_COMPOSE_OVERLAYS ''
  [ "$rc" -eq 0 ] || return 1
  check 'it stopped nothing' lacks 'stopping the application services' "$workdir/config-only.log"
  check 'it saw the images were the running ones' grep -q 'only the Compose files can change' "$workdir/config-only.log"
  check 'APP_VERSION still names the build that runs' [ "$(setting APP_VERSION)" != 'drill-config-only' ]
  check 'web was left alone' [ "$(container_of web)" = "$web_before" ]
  check 'worker was left alone' [ "$(container_of worker)" = "$worker_before" ]
  check 'the edge was recreated with the change' [ "$(container_of edge)" != "$edge_before" ]
  check 'the edge carries the new label' [ "$(docker inspect -f '{{index .Config.Labels "x-zoo-drill.config"}}' \
    "$(container_of edge)")" = 'applied' ]
}

# And the other way: a candidate that brings a migration still stops the
# writers, backs up, migrates and starts, exactly as before.
case_pending_migration() {
  ensure_deployed || return 1
  local rc=0 gap failed total
  start_probe pending
  run_expect 0 "$workdir/pending.log" \
    upgrade --app-version drill-pending \
    --web "$web_v2" --worker "$worker_v3" --edge "$edge_v2" || rc=1
  stop_probe
  [ "$rc" -eq 0 ] || return 1
  read -r gap failed total <<<"$(probe_summary)"
  note "measured, for comparison: $failed of $total requests failed; the longest gap was $gap ms"
  check 'it found the migration' grep -q '1 migration(s) to apply: 9000_drill_marker' "$workdir/pending.log"
  check 'it stopped the writers' grep -q 'stopping the application services' "$workdir/pending.log"
  check 'a verified dump was taken first' grep -qE '^backup: ' "$workdir/pending.log"
  check 'the migration ran' [ "$(psql_q "select to_regclass('public.drill_marker') is not null")" = 't' ]
  check 'worker is on v3' on_release worker "$worker_v3"
  check 'the manifest records the path' grep -q '^path=stopped' "$(last_manifest)"
}

# --- ship.sh ---------------------------------------------------------------------------------

ship_dir="$workdir/host"
ship_bin="$workdir/bin"
ship_sha=''
ship_web=''
ship_ready=0

# What CI would have done for HEAD (published its images as `sha-<HEAD>`, and
# passed), and a release directory holding only what the host owns.
ensure_ship() {
  case "$ship_ready" in
    1) return 0 ;;
    -1) return 1 ;;
  esac
  ship_ready=-1
  ensure_deployed || return 1
  ship_sha="$(git -C "$repo_root" rev-parse --verify -q HEAD)" || {
    note 'not a git checkout'
    return 1
  }
  [ -z "$(git -C "$repo_root" status --porcelain -- deploy)" ] ||
    note "deploy/ has uncommitted changes; the ship cases ship HEAD ($ship_sha) without them"
  # What CI published for HEAD is the image the stack was first deployed with, so
  # shipping it over a first deploy would recreate nothing and every check below
  # about "runs what CI published" would hold with nothing shipped. Move the
  # stack off those images first, as an earlier case does when the cases run
  # in order.
  if ! on_release web "$web_v2"; then
    run_expect 0 "$workdir/ship-base.log" \
      upgrade --app-version drill-ship-base \
      --web "$web_v2" --worker "$worker_v2" --edge "$edge_v2" || return 1
  fi
  ship_web="$(publish "$web_src" x-zoo-web "sha-$ship_sha")" || return 1
  publish "$worker_src" x-zoo-worker "sha-$ship_sha" >/dev/null || return 1
  publish "$edge_src" x-zoo-edge "sha-$ship_sha" >/dev/null || return 1
  mkdir -p "$ship_bin" "$ship_dir/data"
  cat >"$ship_bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stands in for `gh run list`: answers DRILL_CI for the commit the drill ships,
# and nothing for any other.
case " $* " in
  *" run list "*"--commit $DRILL_SHA "*) printf '%s\n' "${DRILL_CI:-completed success}" ;;
esac
EOF
  chmod +x "$ship_bin/gh"
  cp -p "$NEXT_DEPLOYMENT_ENV" "$ship_dir/deployment.env"
  printf '# drill: owned by the host\n' >>"$ship_dir/deployment.env"
  printf 'the host keeps this\n' >"$ship_dir/data/keep-me"
  # From here on the release directory's settings are the deployment's.
  settings="$ship_dir/deployment.env"
  ship_ready=1
}

ship() {
  PATH="$ship_bin:$PATH" DRILL_SHA="$ship_sha" SHIP_HOST=local SHIP_DIR="$ship_dir" \
    SHIP_REMOTE="$repo_root" SHIP_BRANCH=HEAD "$deploy_dir/ship.sh" "$@"
}

host_owned_intact() {
  [ "$(stat -c '%a' "$ship_dir/deployment.env")" = '600' ] &&
    grep -q '^# drill: owned by the host$' "$ship_dir/deployment.env" &&
    [ "$(cat "$ship_dir/data/keep-me")" = 'the host keeps this' ]
}

tree_of() { (cd "$1" && find . -type f -printf '%P %s %T@ %m\n' | LC_ALL=C sort); }

case_ship_refuses_red_ci() {
  ensure_ship || return 1
  DRILL_CI='completed failure' run_expect 4 "$workdir/ship-red.log" ship "$ship_sha" || return 1
  check 'it says CI did not pass' grep -q 'CI did not pass' "$workdir/ship-red.log"
  DRILL_CI='in_progress ' run_expect 4 "$workdir/ship-running.log" ship "$ship_sha" || return 1
  check 'it waits for a CI run still in progress' grep -q 'CI is still running' "$workdir/ship-running.log"
  check 'nothing was shipped' [ ! -e "$ship_dir/shop" ]
}

case_ship_dry_run() {
  ensure_ship || return 1
  local before web_before
  before="$(tree_of "$ship_dir")"
  web_before="$(running web)"
  run_expect 0 "$workdir/ship-dry.log" ship --dry-run "$ship_sha" || return 1
  check 'it resolved the digests CI published' grep -qF "web:    $ship_web" "$workdir/ship-dry.log"
  check 'it lists the files it would add' grep -q '^  + shop$' "$workdir/ship-dry.log"
  check 'the staged upgrade ran as a dry run' grep -q 'dry run: nothing was stopped' "$workdir/ship-dry.log"
  check 'the release directory is unchanged' [ "$before" = "$(tree_of "$ship_dir")" ]
  check 'the stack is unchanged' [ "$(running web)" = "$web_before" ]
}

case_ship_fresh_dir() {
  ensure_ship || return 1
  [ ! -e "$ship_dir/shop" ] || {
    note 'the release directory is not fresh'
    return 77
  }
  run_expect 0 "$workdir/ship-fresh.log" ship "$ship_sha" || return 1
  check 'shop is there and executable' [ -x "$ship_dir/shop" ]
  check 'the Compose files and lib/ are there' \
    test -f "$ship_dir/compose.yml" -a -f "$ship_dir/compose.traefik.yml" -a -f "$ship_dir/lib/commands/upgrade.sh"
  check 'the drill, the docs and ship.sh are not' \
    test ! -e "$ship_dir/rehearsal" -a ! -e "$ship_dir/README.md" -a ! -e "$ship_dir/ship.sh"
  check 'shipped.list names exactly what was shipped' [ "$(LC_ALL=C sort "$ship_dir/data/shipped.list")" = \
    "$(cd "$ship_dir" && find . -type f ! -path './data/*' ! -name deployment.env ! -name REVISION -printf '%P\n' | LC_ALL=C sort)" ]
  check 'REVISION names the commit' [ "$(cat "$ship_dir/REVISION")" = "$ship_sha" ]
  check 'web runs what CI published for it' on_release web "$ship_web"
  check 'it stopped nothing' lacks 'stopping the application services' "$workdir/ship-fresh.log"
  check 'deployment.env and data/ survived' host_owned_intact
  check 'it did not look for the site from outside' grep -q 'no public host name' "$workdir/ship-fresh.log"
}

case_ship_removes() {
  ensure_ship || return 1
  [ -f "$ship_dir/data/shipped.list" ] || {
    note 'nothing has been shipped yet (run without --only)'
    return 77
  }
  # What an earlier release shipped and this one no longer has, and a file the
  # operator put there that no release ever shipped.
  mkdir -p "$ship_dir/lib/retired"
  printf 'old\n' >"$ship_dir/lib/retired/old.sh"
  printf 'old\n' >"$ship_dir/retired.yml"
  printf 'lib/retired/old.sh\nretired.yml\n' >>"$ship_dir/data/shipped.list"
  printf 'mine\n' >"$ship_dir/operator-notes.txt"
  local web_before
  web_before="$(container_of web)"
  run_expect 0 "$workdir/ship-again.log" ship "$ship_sha" || return 1
  check 'it listed the removals' grep -q '^  - retired.yml$' "$workdir/ship-again.log"
  check 'the retired files are gone' test ! -e "$ship_dir/retired.yml" -a ! -e "$ship_dir/lib/retired"
  check 'shipped.list no longer names them' lacks retired "$ship_dir/data/shipped.list"
  check 'a file no release shipped is left alone' [ "$(cat "$ship_dir/operator-notes.txt")" = 'mine' ]
  check 'deployment.env and data/ survived' host_owned_intact
  check 'the same release again recreated nothing' [ "$(container_of web)" = "$web_before" ]
}

# Somebody else's upgrade or rollback holds the host's lock: a release is
# refused before it touches a file, and so is a rollback typed on the host.
case_ship_locked() {
  ensure_ship || return 1
  [ -x "$ship_dir/shop" ] || {
    note 'nothing has been shipped yet (run without --only)'
    return 77
  }
  local lock="$ship_dir/data/shop.lock" holder before web_before tries=0
  # `-o`: sleep does not inherit the lock, so killing flock releases it.
  flock -o "$lock" sleep 600 &
  holder=$!
  while flock -n "$lock" true; do
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || {
      kill "$holder" 2>/dev/null
      note 'could not take the lock for the case'
      return 1
    }
    sleep 0.1
  done
  before="$(tree_of "$ship_dir" | grep -v '^data/')"
  web_before="$(container_of web)"
  local code=0
  run_expect 4 "$workdir/ship-locked.log" ship "$ship_sha" || code=1
  run_expect 4 "$workdir/rollback-locked.log" \
    env NEXT_DEPLOYMENT_ENV="$ship_dir/deployment.env" "$ship_dir/shop" rollback --last-upgrade || code=1
  kill "$holder" 2>/dev/null
  wait "$holder" 2>/dev/null || true
  [ "$code" -eq 0 ] || return 1
  check 'it says another release is running' grep -q 'another upgrade or rollback is running' "$workdir/ship-locked.log"
  check 'the rollback on the host says so too' grep -q 'another upgrade or rollback is running' "$workdir/rollback-locked.log"
  check 'no shipped file changed' [ "$before" = "$(tree_of "$ship_dir" | grep -v '^data/')" ]
  check 'the stack was not touched' [ "$(container_of web)" = "$web_before" ]
}

# The upgrade fails and the images go back; so must the Compose files and the
# scripts, or the host describes a release it is not running.
case_ship_failed_upgrade() {
  ensure_ship || return 1
  [ -f "$ship_dir/data/shipped.list" ] || {
    note 'nothing has been shipped yet (run without --only)'
    return 77
  }
  # The previous release, made different from this one in both directions: a
  # file this release changes, and one it no longer ships.
  printf '# drill: the previous release\n' >>"$ship_dir/lib/commands/status.sh"
  printf 'old\n' >"$ship_dir/previous-only.yml"
  printf 'previous-only.yml\n' >>"$ship_dir/data/shipped.list"
  local status_before list_before worker_before
  status_before="$(cat "$ship_dir/lib/commands/status.sh")"
  list_before="$(cat "$ship_dir/data/shipped.list")"
  worker_before="$(running worker)"

  # CI "published" a worker whose migration fails. ship.sh puts the files back
  # for any upgrade that exits non-zero, whatever failed; a migration says so in
  # seconds, where a worker that never turns healthy takes the whole healthcheck
  # (`upgrade/unhealthy-worker-ends-on-previous` drills that one).
  publish "x-zoo-worker:$image_tag-badmigrate" x-zoo-worker "sha-$ship_sha" >/dev/null || return 1
  local code=0
  run_expect 1 "$workdir/ship-failed.log" ship "$ship_sha" || code=1
  publish "$worker_src" x-zoo-worker "sha-$ship_sha" >/dev/null || return 1
  [ "$code" -eq 0 ] || return 1

  check 'the upgrade failed on the migration' grep -q 'the migration failed' "$workdir/ship-failed.log"
  check 'it says the files were put back' grep -q 'previous release files again' "$workdir/ship-failed.log"
  check 'the changed file is the previous one again' \
    [ "$(cat "$ship_dir/lib/commands/status.sh")" = "$status_before" ]
  check 'the file it no longer ships is back' [ "$(cat "$ship_dir/previous-only.yml" 2>/dev/null)" = 'old' ]
  check 'shipped.list is the previous one' [ "$(cat "$ship_dir/data/shipped.list")" = "$list_before" ]
  check 'the worker runs what it ran before' [ "$(running worker)" = "$worker_before" ]
  check 'REVISION still names the previous release' [ "$(cat "$ship_dir/REVISION")" = "$ship_sha" ]
  check 'no snapshot is left behind' [ -z "$(find "$ship_dir/data/releases" -name '*.previous.tar')" ]
  check 'deployment.env and data/ survived' host_owned_intact

  # And the same release, healthy this time, ships over it cleanly.
  run_expect 0 "$workdir/ship-after-failed.log" ship "$ship_sha" || return 1
  check 'the next release removes the file again' test ! -e "$ship_dir/previous-only.yml"
  check 'and restores this release status.sh' lacks 'drill: the previous release' "$ship_dir/lib/commands/status.sh"
}

case_ship_forwards() {
  ensure_ship || return 1
  [ -x "$ship_dir/shop" ] || {
    note 'nothing has been shipped yet (run without --only)'
    return 77
  }
  run_expect 0 "$workdir/ship-status.log" ship status || return 1
  check 'status names the release' grep -q "^release:   $ship_sha" "$workdir/ship-status.log"
  check 'status runs the gate' grep -q 'readiness gate: passed' "$workdir/ship-status.log"
  run_expect 0 "$workdir/ship-backup.log" ship backup --out "$workdir/forwarded.sql.gz" || return 1
  check 'backup verified its dump' grep -q 'backup verified' "$workdir/ship-backup.log"
  run_expect 0 "$workdir/ship-rollback.log" ship rollback --last-upgrade || return 1
  check 'rollback ran on the host' grep -q '^rolled back:' "$workdir/ship-rollback.log"
  check 'REVISION still names the release it returned to' [ "$(cat "$ship_dir/REVISION")" = "$ship_sha" ]
  run_expect 2 "$workdir/ship-misuse.log" ship status --bogus || return 1
}

# --- run ---------------------------------------------------------------------------------

step 'running the cases'

for index in "${!CASE_IDS[@]}"; do
  run_case "${CASE_IDS[$index]}" "${CASE_FNS[$index]}" "${CASE_SHARDS[$index]}"
done

step 'results'
printf '%s\n' "${results[@]:-<none selected>}"
printf '\n%s passed, %s failed, %s skipped\n' "$passed" "$failed" "$skipped"
[ "$failed" -eq 0 ]
