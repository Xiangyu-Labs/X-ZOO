# shellcheck shell=bash
# Shared by `shop` and its commands (lib/commands/). Not executable on its own.
#
# No `set` here: the caller sets `-Eeuo pipefail` and owns its own traps.
#
# Rules this file exists to keep in one place:
#   - no secret ever reaches argv; passwords are read inside the container
#     from the container's own environment;
#   - `docker compose` is always called with the same project, files and env
#     file, so a rehearsal against a disposable copy is one variable away, and
#     no script can recreate a container without the overlays the deployment
#     runs with;
#   - an image reference recorded for rollback is immutable — a digest, or for
#     a locally built image the content id alongside the reference.

# shellcheck disable=SC2034  # read by the scripts that source this file.
APP_SERVICES='web worker edge'
# shellcheck disable=SC2034  # read by lib/readiness.sh.
DATA_SERVICES='postgres redis'

deploy_root="${NEXT_DEPLOY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
compose_file="${NEXT_COMPOSE_FILE:-$deploy_root/compose.yml}"
settings="${NEXT_DEPLOYMENT_ENV:-$deploy_root/deployment.env}"
project="${NEXT_PROJECT:-x-zoo}"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_settings() {
  test -f "$settings" || die "the deployment settings are missing: $settings
  cp $deploy_root/deployment.env.example $settings && chmod 600 $settings"
  local key
  for key in NEXT_WEB_IMAGE NEXT_WORKER_IMAGE NEXT_EDGE_IMAGE DATABASE_URL REDIS_URL; do
    grep -q "^$key=" "$settings" || die "$key is missing from $settings"
  done
  # A file holding two passwords must not be world readable.
  local mode
  mode="$(stat -c '%a' "$settings")"
  case "$mode" in
    600 | 400 | 640) ;;
    *) warn "warning: $settings is mode $mode; 600 is expected" ;;
  esac
  # The placeholders in deployment.env.example are not credentials, and a
  # deployment that still carries them is a deployment nobody configured.
  if grep -q 'CHANGE-ME' "$settings"; then
    die "$settings still contains CHANGE-ME placeholders; configure it first"
  fi
  # A listed overlay that is not there must stop the script here. Compose would
  # refuse it too, but only at the first call, and some calls are allowed to
  # fail (`compose ps` reads as "not running"), which would turn a typo into
  # "the stack is down".
  local overlay
  while IFS= read -r overlay; do
    [ -f "$overlay" ] || die "NEXT_COMPOSE_OVERLAYS names $overlay, which does not exist"
  done < <(compose_overlays)
}

# The overlay files the deployment runs with, one resolved path per line, in
# the order `NEXT_COMPOSE_OVERLAYS` lists them. The key holds file names
# separated by spaces or commas; a relative name is resolved against the
# deploy directory, not the caller's working directory. Unset or empty means
# `compose.yml` alone.
#
# The overlays are a setting of the deployment rather than a flag of each
# script because an overlay that only some invocations name is an overlay the
# next `up` silently removes: Compose recreates a container from whichever files
# it is given, and the one that recreated the edge without
# `compose.traefik.yml` has taken it off the router.
compose_overlays() {
  local raw overlay
  local -a overlays
  raw="$(setting NEXT_COMPOSE_OVERLAYS 2>/dev/null || true)"
  raw="${raw#[\"\']}"
  raw="${raw%[\"\']}"
  IFS=$', \t' read -r -a overlays <<<"$raw"
  for overlay in "${overlays[@]}"; do
    case "$overlay" in
      /*) ;;
      *) overlay="$deploy_root/${overlay#./}" ;;
    esac
    printf '%s\n' "$overlay"
  done
}

compose() {
  local overlay
  local -a files=(-f "$compose_file")
  while IFS= read -r overlay; do
    files+=(-f "$overlay")
  done < <(compose_overlays)
  docker compose -p "$project" --project-directory "$deploy_root" \
    "${files[@]}" --env-file "$settings" "$@"
}

# Reads one key out of the settings file. Never echo the result of a credential
# key to a log; callers use this for image references and non-secret values.
setting() {
  sed -n "s/^$1=//p" "$settings" | tail -n1
}

# Where dumps, upgrade manifests and settings backups go: `NEXT_BACKUP_DIR`
# from the environment or the settings, relative to the deploy directory.
backup_dir() {
  local dir="${NEXT_BACKUP_DIR:-$(setting NEXT_BACKUP_DIR)}"
  dir="${dir:-$deploy_root/data/backups}"
  case "$dir" in /*) ;; *) dir="$deploy_root/${dir#./}" ;; esac
  printf '%s\n' "$dir"
}

# The WeChat domain-verification directory the edge mounts read-only at
# `/srv/domain-verification` (compose.yml): `NEXT_DOMAIN_VERIFICATION_DIR`
# from the environment or the settings, relative to the deploy directory —
# the same default and the same base as the Compose file's.
verification_dir() {
  local dir="${NEXT_DOMAIN_VERIFICATION_DIR:-$(setting NEXT_DOMAIN_VERIFICATION_DIR)}"
  dir="${dir:-$deploy_root/data/domain-verification}"
  case "$dir" in /*) ;; *) dir="$deploy_root/${dir#./}" ;; esac
  printf '%s\n' "$dir"
}

# Rewrites one key in place, preserving mode. Used only for image digests.
set_setting() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp "$settings.XXXXXX")"
  chmod 600 "$temporary"
  if grep -q "^$key=" "$settings"; then
    # `value` is an image reference; `|` cannot appear in one.
    sed "s|^$key=.*|$key=$value|" "$settings" >"$temporary"
  else
    cat "$settings" >"$temporary"
    printf '%s=%s\n' "$key" "$value" >>"$temporary"
  fi
  cat "$temporary" >"$settings"
  rm -f "$temporary"
}

is_digest_ref() {
  [[ "$1" =~ ^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]]
}

# The candidate a release is deployed from must be immutable. A tag can be
# repointed between the acceptance run and the deploy, which makes "the build
# that passed" unidentifiable — the one thing a rollback target cannot be.
#
# NEXT_ALLOW_LOCAL_IMAGES=1 exists for a rehearsal against locally built
# images. It says so loudly on every run, because a production deploy that
# needed it is a production deploy that skipped the registry.
require_candidate() {
  local role="$1" ref="$2"
  [ -n "$ref" ] || die "no candidate given for $role"
  if is_digest_ref "$ref"; then
    return 0
  fi
  if [ "${NEXT_ALLOW_LOCAL_IMAGES:-0}" = '1' ]; then
    docker image inspect "$ref" >/dev/null 2>&1 ||
      die "NEXT_ALLOW_LOCAL_IMAGES=1 but $role candidate $ref is not present locally"
    warn "warning: $role candidate $ref is not digest-pinned (NEXT_ALLOW_LOCAL_IMAGES=1; rehearsal only)"
    return 0
  fi
  die "$role candidate must be pinned by digest (repo@sha256:<64 hex>), got: $ref"
}

# The immutable reference of the image a service is running right now.
#
# Prefers the registry digest, because that is pullable on a host that has
# since pruned its images. A locally built image has none, so the exact
# reference Compose used is recorded instead and the content id is carried
# separately — fabricating `local:sha256:...` would produce a reference Docker
# refuses.
running_image_ref() {
  local service="$1" container image_id digest_ref repo
  container="$(compose ps -q "$service" 2>/dev/null || true)"
  [ -n "$container" ] || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  [ -n "$image_id" ] || return 1
  repo="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  repo="${repo%%@*}"
  # Strip a tag, but only a real one. A registry host may carry a port, and
  # `${repo%%:*}` would turn `127.0.0.1:15000/x-zoo-web` into `127.0.0.1`
  # — which matches no RepoDigest, so the digest lookup below would silently
  # fall back to the plain reference. Only a colon after the last `/` is a tag.
  case "${repo##*/}" in *:*) repo="${repo%:*}" ;; esac
  digest_ref="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null |
    grep -F "${repo}@sha256:" | head -n1 || true)"
  if [ -z "$digest_ref" ]; then
    digest_ref="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
    [ -n "$digest_ref" ] || return 1
  fi
  printf '%s %s\n' "$digest_ref" "$image_id"
}

# Asserts a service is running exactly the image reference and content given.
# The content id matters: `docker build -t x .` twice gives one reference and
# two different images, and a rollback that landed on the wrong one would
# report success.
service_runs() {
  local service="$1" want_ref="$2" want_id="$3" container actual_ref actual_id
  container="$(compose ps -q "$service" 2>/dev/null || true)"
  [ -n "$container" ] || return 1
  actual_ref="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  actual_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  [ "$actual_ref" = "$want_ref" ] || return 1
  [ -z "$want_id" ] || [ "$actual_id" = "$want_id" ] || return 1
}

# Runs psql inside the postgres container. The credentials are read there, from
# the container's own environment: the host never holds a copy, and nothing
# lands in `/proc/*/cmdline`.
psql_q() {
  # shellcheck disable=SC2016  # the point: $POSTGRES_USER is expanded by the
  # shell inside the container, from the container's own environment.
  compose exec -T postgres sh -c \
    'exec psql -v ON_ERROR_STOP=1 -qtAX -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' _ "$1"
}
