#!/usr/bin/env bash
# Deploy a release, and end on the previous images if it does not come up.
#
#   shop upgrade \
#     --web    ghcr.io/…/x-zoo-web@sha256:… \
#     --worker ghcr.io/…/x-zoo-worker@sha256:… \
#     --edge   ghcr.io/…/x-zoo-edge@sha256:… \
#     [--app-version <commit>] [--dry-run] [--skip-migration] [--first-deploy]
#
# In order, refusing to continue when a step cannot be proven:
#
#   1. all three candidates are fixed digests (a moving tag is refused), and
#      the running images are recorded as the rollback target;
#   2. the candidates are pulled *before* anything is stopped, so a registry
#      problem is not discovered mid-window;
#   3. the candidate worker image is asked, read-only, whether the database
#      has migrations it has not applied (`db/src/pending.mjs`);
#   4. then one of two paths:
#
#      - **migrations pending** (or the question could not be answered, or
#        this is the first deploy): `web`, `worker` and `edge` are stopped — a
#        migration never runs against live writers — a dump is taken and
#        proved restorable, the migrations and the reference seed run as the
#        `migrate` one-shot, and the stack starts on the candidates;
#      - **nothing to migrate**: nothing is stopped. The dump is still taken
#        and proved (`pg_dump` reads one consistent snapshot, and that dump is
#        the way back), the reference seed runs beside the live stack, and
#        `up -d` recreates only the services whose image or configuration
#        changed, `web` first and the edge last. A release that changes only
#        the Compose files — a label, a redirect — goes through here too, and
#        changes only what they change;
#
#   5. the stack has to pass the readiness gate;
#   6. **any failure after the candidates are pinned rolls the images back to
#      what was running**, and the script says whether the schema had moved.
#
# Why the seed may run beside live writers: every statement in it is an upsert
# on a natural key, inside one transaction, and it touches only reference
# tables (cities, express companies, agreement and notification shells). It
# never deletes or truncates. Readers do not wait on it; a write to one of the
# same rows waits for its commit, a few seconds at most.
#
# Why an automatic rollback rather than stopping in maintenance mode: the
# migrations are additive (CI refuses one that is not), so the previous image
# tolerates the new schema, and an unattended failure is better ending on a
# stack that serves than on a stack that is down. When the migration had
# already run, the script says so in as many words and names the dump, because
# *data* recovery is a separate, deliberate operation and this script never
# performs one.
#
# `--skip-migration` runs neither the migrations nor the seed, and so stops
# nothing. `--dry-run` goes as far as step 3, reports the path the release
# would take, and changes nothing.
#
# Exit codes: 0 deployed · 1 failed, rolled back to the previous images ·
#             2 misuse · 3 failed AND the rollback failed — needs a human.
#             4 another upgrade or rollback holds the lock (`shop`); nothing changed.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
. "$here/../common.sh"
# shellcheck source=../readiness.sh
. "$here/../readiness.sh"

web_candidate=''
worker_candidate=''
edge_candidate=''
app_version=''
dry_run=0
skip_migration=0
first_deploy=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --web)
      web_candidate="${2:?--web needs an image}"
      shift
      ;;
    --web=*) web_candidate="${1#*=}" ;;
    --worker)
      worker_candidate="${2:?--worker needs an image}"
      shift
      ;;
    --worker=*) worker_candidate="${1#*=}" ;;
    --edge)
      edge_candidate="${2:?--edge needs an image}"
      shift
      ;;
    --edge=*) edge_candidate="${1#*=}" ;;
    --app-version)
      app_version="${2:?--app-version needs a value}"
      shift
      ;;
    --app-version=*) app_version="${1#*=}" ;;
    --dry-run) dry_run=1 ;;
    --skip-migration) skip_migration=1 ;;
    --first-deploy) first_deploy=1 ;;
    -h | --help)
      sed -n '2,55p' "$0"
      exit 0
      ;;
    *)
      warn "unknown argument: $1"
      exit 2
      ;;
  esac
  shift
done

require_settings
compose config >/dev/null || die 'the compose configuration cannot be parsed'

# All three, always. A release where `web` moved and `worker` did not is a web
# talking to a worker built against a different contract; there is no reason to
# make that easy to type.
require_candidate web "$web_candidate"
require_candidate worker "$worker_candidate"
require_candidate edge "$edge_candidate"

# --- 1. record what is running -----------------------------------------------
declare -A previous_ref previous_id
missing=0
for service in $APP_SERVICES; do
  if captured="$(running_image_ref "$service")"; then
    previous_ref["$service"]="${captured%% *}"
    previous_id["$service"]="${captured##* }"
    say "current $service: ${previous_ref[$service]}"
  else
    previous_ref["$service"]=''
    previous_id["$service"]=''
    missing=$((missing + 1))
    warn "no running container for $service"
  fi
done

if [ "$missing" -gt 0 ] && [ "$first_deploy" -eq 0 ]; then
  die "$missing application service(s) are not running, so there is no rollback target.
  Pass --first-deploy if this host has never deployed the new stack."
fi
if [ "$missing" -eq 0 ] && [ "$first_deploy" -eq 1 ]; then
  die '--first-deploy was given but the stack is already running; refusing to guess'
fi

say "candidate web:    $web_candidate"
say "candidate worker: $worker_candidate"
say "candidate edge:   $edge_candidate"

# The same three images as are running: a release of the Compose files alone.
# `APP_VERSION` names the commit the running images were built from, and they
# do not change, so neither does it; changing it would recreate `web` and
# `worker` for nothing.
same_images=0
if [ "${previous_ref[web]}" = "$web_candidate" ] &&
  [ "${previous_ref[worker]}" = "$worker_candidate" ] &&
  [ "${previous_ref[edge]}" = "$edge_candidate" ]; then
  same_images=1
  say 'the candidates are the images already running: only the Compose files can change'
fi

# --- 2. pull before anything is stopped --------------------------------------
for candidate in "$web_candidate" "$worker_candidate" "$edge_candidate"; do
  if is_digest_ref "$candidate"; then
    docker pull "$candidate" >/dev/null || die "could not pull $candidate"
  fi
  docker image inspect "$candidate" >/dev/null 2>&1 ||
    die "candidate is not available locally: $candidate"
done
say 'all candidates are present locally'

# --- 3. is there anything to migrate? ----------------------------------------
# Asked of the *candidate*: it is the candidate's migrations that would run.
# The one-shot is given the candidate image through the environment, which
# Compose prefers over the settings file, so nothing is pinned to ask.
pending=''
pending_names=''
path='stopped'
if [ "$first_deploy" -eq 1 ]; then
  say 'first deploy: the stack is not running, so there is nothing to keep serving'
elif [ "$skip_migration" -eq 1 ]; then
  path='online'
  say 'skipping the migrations and the seed as requested: nothing needs to stop'
else
  asked="$(mktemp)"
  answer="$(NEXT_WORKER_IMAGE="$worker_candidate" \
    compose --profile migrate run --rm --no-deps -T migrate node /app/db/src/pending.mjs 2>"$asked")" ||
    answer=''
  pending="$(printf '%s\n' "$answer" | sed -n 's/^pending=//p' | tail -n1)"
  if ! [[ "$pending" =~ ^[0-9]+$ ]]; then
    pending='unknown'
    warn 'could not ask the candidate whether anything is left to migrate; taking the stopping path'
    tail -n 5 "$asked" | sed 's/^/  /' >&2
  elif [ "$pending" -eq 0 ]; then
    path='online'
    say 'nothing to migrate: the release will not stop anything'
  else
    pending_names="$(printf '%s\n' "$answer" | sed -n 's/^migration=//p' | paste -sd ' ' -)"
    say "$pending migration(s) to apply: $pending_names"
  fi
  rm -f "$asked"
fi

if [ "$dry_run" -eq 1 ]; then
  if [ "$path" = 'online' ]; then
    say 'dry run: the release would stop nothing'
  else
    say 'dry run: the release would stop web, worker and edge to migrate'
  fi
  say 'dry run: nothing was stopped, no backup was taken, no migration ran'
  exit 0
fi

backup_dir="$(backup_dir)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

# The edge mounts this read-only. Created here so that Docker does not create
# it as root on the first `up`, which would leave the operator unable to place a
# verification file without sudo. Readable by all: nginx's workers are not the
# host user. An existing directory, and whatever is in it, is left alone.
verification_dir="$(verification_dir)"
if [ ! -d "$verification_dir" ]; then
  mkdir -p "$verification_dir"
  chmod 755 "$verification_dir"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
manifest="$backup_dir/upgrade-$stamp.manifest"
settings_backup="$backup_dir/deployment.env.$stamp"
cp -p "$settings" "$settings_backup"
chmod 600 "$settings_backup"

previous_revision=''
[ ! -s "$deploy_root/REVISION" ] || previous_revision="$(head -n1 "$deploy_root/REVISION")"

{
  printf 'stamp=%s\n' "$stamp"
  printf 'settings_backup=%s\n' "$settings_backup"
  printf 'previous_revision=%s\n' "$previous_revision"
  printf 'app_version=%s\n' "$app_version"
  for service in $APP_SERVICES; do
    printf 'previous_%s=%s\n' "$service" "${previous_ref[$service]}"
    printf 'previous_%s_id=%s\n' "$service" "${previous_id[$service]}"
  done
  printf 'candidate_web=%s\n' "$web_candidate"
  printf 'candidate_worker=%s\n' "$worker_candidate"
  printf 'candidate_edge=%s\n' "$edge_candidate"
  printf 'pending=%s\n' "${pending:-not asked}"
  printf 'path=%s\n' "$path"
} >"$manifest"
chmod 600 "$manifest"
say "manifest: $manifest"

migrated=0
seeded=0
backup_file=''

# --- the rollback path -------------------------------------------------------
roll_back() {
  local reason="$1" service failed=0
  warn ''
  warn "UPGRADE FAILED: $reason"
  if [ "$first_deploy" -eq 1 ]; then
    warn 'This was a first deploy: there is no previous image to return to, so'
    warn 'there is nothing to roll back to and nothing was taken away from anyone.'
    warn "The stack is left as it is; the settings backup is $settings_backup."
    warn 'Read the logs of the service that did not come up, fix it, and re-run.'
    printf 'outcome=first-deploy-failed\nreason=%s\n' "$reason" >>"$manifest"
    # 1, not 3: "needs a human" is about a stack that lost its way back. A
    # first deploy that did not come up has no way back to lose.
    exit 1
  fi
  warn 'Returning to the previously running images.'
  cp -p "$settings_backup" "$settings"
  if ! compose up -d --wait --wait-timeout 240 >/dev/null 2>&1; then
    warn 'the previous images did not come up either'
    failed=1
  fi
  for service in $APP_SERVICES; do
    if service_runs "$service" "${previous_ref[$service]}" "${previous_id[$service]}"; then
      warn "  $service is back on ${previous_ref[$service]}"
    else
      warn "  $service is NOT on ${previous_ref[$service]}"
      failed=1
    fi
  done
  if [ "$migrated" -eq 1 ]; then
    warn ''
    warn 'NOTE: the migrations had already run, so the database is on the NEW schema'
    warn 'while the containers are on the PREVIOUS images. The migrations are additive,'
    warn 'so this serves; it is not a state to leave a release in.'
    warn "  verified dump: ${backup_file:-<none>}"
    warn "  restore it deliberately — no script here does it for you."
  else
    warn ''
    warn 'No migration ran: the schema did not move.'
    if [ "$seeded" -eq 1 ]; then
      warn 'The reference seed ran. It only upserts reference rows, which the previous'
      warn 'images read as before.'
    fi
  fi
  printf 'outcome=rolled-back\nreason=%s\nmigrated=%s\n' "$reason" "$migrated" >>"$manifest"
  return "$failed"
}

fail() {
  if roll_back "$1"; then
    exit 1
  fi
  warn ''
  warn 'THE ROLLBACK ALSO FAILED. The stack needs a human.'
  exit 3
}

pin_candidates() {
  set_setting NEXT_WEB_IMAGE "$web_candidate"
  set_setting NEXT_WORKER_IMAGE "$worker_candidate"
  set_setting NEXT_EDGE_IMAGE "$edge_candidate"
  if [ -n "$app_version" ] && [ "$same_images" -eq 0 ]; then
    set_setting APP_VERSION "$app_version"
  fi
}

take_backup() {
  say 'backing up the database'
  bash "$here/backup.sh" --out "$backup_dir/pre-upgrade-$stamp.sql.gz" | sed '$d' || return 1
  backup_file="$backup_dir/pre-upgrade-$stamp.sql.gz"
  printf 'backup=%s\n' "$backup_file" >>"$manifest"
  say "backup: $backup_file"
}

if [ "$path" = 'stopped' ]; then
  # --- 4a. stop the writers, back up, migrate ---------------------------------
  say 'stopping the application services'
  # shellcheck disable=SC2086  # deliberate word splitting: a list of services.
  compose stop $APP_SERVICES >/dev/null

  if [ "$first_deploy" -eq 1 ]; then
    say 'first deploy: no database to back up yet'
    compose up -d --wait --wait-timeout 180 postgres redis >/dev/null ||
      die 'postgres/redis did not come up'
  else
    take_backup || {
      warn 'the backup could not be taken or verified; nothing was migrated'
      cp -p "$settings_backup" "$settings"
      compose up -d --wait --wait-timeout 240 >/dev/null 2>&1 || true
      printf 'outcome=aborted\nreason=the backup could not be taken or verified\n' >>"$manifest"
      exit 1
    }
  fi

  pin_candidates

  if [ "$skip_migration" -eq 0 ]; then
    say 'running the migrations and the reference seed'
    migrated=1
    seeded=1
    compose --profile migrate run --rm --no-deps -T migrate ||
      fail 'the migration failed'
  else
    say 'skipping the migrations as requested'
  fi
else
  # --- 4b. nothing to migrate: back up beside the live stack, seed ------------
  take_backup || {
    warn 'the backup could not be taken or verified; nothing was changed'
    printf 'outcome=aborted\nreason=the backup could not be taken or verified\n' >>"$manifest"
    exit 1
  }

  pin_candidates

  if [ "$skip_migration" -eq 0 ]; then
    say 'running the reference seed beside the live stack'
    seeded=1
    compose --profile migrate run --rm --no-deps -T migrate node /app/db/src/seed/index.mjs ||
      fail 'the reference seed failed'
  fi
fi

# --- 5. start and prove it -----------------------------------------------------
if [ "$path" = 'stopped' ]; then
  say 'starting the stack on the candidates'
else
  # One service at a time, `web` first: a single `up` would stop every
  # service it recreates before starting any of them, and the edge, which
  # waits for a healthy `web`, would be down for all of it. This way the edge
  # keeps serving while `web` is replaced (it finds the new one by name), and
  # is itself replaced last, in the second or so nginx takes to start.
  say 'applying the release: Compose recreates only what changed, web first'
  for service in web worker; do
    compose up -d --wait --wait-timeout 300 --no-deps "$service" >/dev/null ||
      fail "$service did not become healthy"
  done
fi
compose up -d --wait --wait-timeout 300 >/dev/null ||
  fail 'the stack did not become healthy'

for service in $APP_SERVICES; do
  case "$service" in
    web) want="$web_candidate" ;;
    worker) want="$worker_candidate" ;;
    edge) want="$edge_candidate" ;;
    *) want='' ;;
  esac
  service_runs "$service" "$want" '' ||
    fail "$service is not running the candidate $want"
done

readiness_gate || fail 'the readiness gate did not pass'

printf 'outcome=deployed\nmigrated=%s\n' "$migrated" >>"$manifest"
say ''
say 'upgrade complete'
say "  web:    $web_candidate"
say "  worker: $worker_candidate"
say "  edge:   $edge_candidate"
if [ "$path" = 'online' ]; then
  say '  path:   nothing was stopped'
else
  say '  path:   stopped to migrate'
fi
say "  rollback target: ${previous_ref[web]:-<none>} / ${previous_ref[worker]:-<none>} / ${previous_ref[edge]:-<none>}"
say "  manifest: $manifest"
[ -z "$backup_file" ] || say "  backup:   $backup_file"
