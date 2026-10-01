#!/usr/bin/env bash
# Dump the database, then prove the dump is restorable.
#
#   shop backup [--out <file.sql.gz>] [--no-verify]
#   shop backup --verify-only <file.sql.gz>
#
# "The dump exists" and "the dump is usable" are different claims, and only the
# second one is worth a release waiting for. So the default path restores the
# dump into a throwaway PostgreSQL with **no network at all** and compares the
# row count of every table in `public`:
#
#   - against the rows the dump itself carries, always: every row it holds
#     must come back;
#   - against the live database, when nothing is writing to it (`web` and
#     `worker` stopped, as during a release that migrates): the dump must hold
#     every row there is.
#
# While the writers run, the live counts move under the comparison, so the
# second check becomes "the dump has every table the live database has".
# `pg_dump` reads one consistent snapshot either way, which is what makes a
# dump taken beside live traffic a valid rollback point.
#
# `--no-verify` exists for a scheduled dump on a host with no spare memory; a
# release never uses it. `--verify-only` runs the proof against a dump that
# already exists and takes none — for checking last night's backup, or the one
# a recovery is about to depend on. It compares against the live database, so
# run it while nothing is writing, or expect the counts to disagree.
#
# Exit codes: 0 verified · 1 the dump failed or does not verify · 2 misuse.
set -Eeuo pipefail

# shellcheck source=../common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../common.sh"

out=''
verify=1
verify_only=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only)
      verify_only="${2:?--verify-only needs a path}"
      shift
      ;;
    --verify-only=*) verify_only="${1#*=}" ;;
    --out)
      out="${2:?--out needs a path}"
      shift
      ;;
    --out=*) out="${1#*=}" ;;
    --no-verify) verify=0 ;;
    -h | --help)
      sed -n '2,30p' "$0"
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

backup_dir="$(backup_dir)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup="${out:-$backup_dir/pre-upgrade-$stamp.sql.gz}"
if [ -n "$verify_only" ]; then
  [ -z "$out" ] || die '--verify-only and --out are mutually exclusive'
  [ "$verify" -eq 1 ] || die '--verify-only and --no-verify are mutually exclusive'
  backup="$verify_only"
fi

# Every table in `public` with its row count, as `table|rows`. `query_to_xml`
# runs a count per table without building the SQL on the host, so a table that
# a later migration adds is included without anyone remembering to add it here.
row_census_sql="select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name"

compose ps -q postgres >/dev/null 2>&1 ||
  die 'postgres is not running; there is nothing to dump or to compare against'

# Whether anything can write while the dump is taken decides what it can be
# compared against (see the top of this file).
writers_live=0
for service in web worker; do
  [ -z "$(compose ps -q --status running "$service" 2>/dev/null || true)" ] || writers_live=1
done

if [ -n "$verify_only" ]; then
  test -s "$backup" || die "the dump is missing or empty: $backup"
  say "verifying an existing dump: $backup"
else
  say "dumping to $backup"
  # The credentials are read inside the container. `--clean --if-exists` makes a
  # restore deterministic whether or not the target already holds objects;
  # `--no-owner` keeps the dump restorable as any role, which is what the
  # verification below needs and what a recovery under time pressure wants.
  # shellcheck disable=SC2016  # deliberate: the credentials are expanded by the
  # shell inside the container, so they never appear in this host's argv.
  if ! compose exec -T postgres sh -c \
    'exec pg_dump --no-owner --no-privileges --clean --if-exists --format=plain -U "$POSTGRES_USER" "$POSTGRES_DB"' \
    >"$backup.part"; then
    rm -f "$backup.part"
    die 'the database dump failed'
  fi
  test -s "$backup.part" || {
    rm -f "$backup.part"
    die 'the database dump is empty'
  }
  gzip -c "$backup.part" >"$backup"
  rm -f "$backup.part"
  chmod 600 "$backup"
fi

gzip -t "$backup" || die "the backup is not a complete gzip stream: $backup"
size="$(wc -c <"$backup")"
[ "$size" -gt 0 ] || die 'the backup file is empty'
if [ -n "$verify_only" ]; then
  say "dump to verify: $backup ($size bytes)"
else
  say "backup written: $backup ($size bytes)"
fi

if [ "$verify" -eq 0 ]; then
  warn 'warning: --no-verify — this dump has not been proven restorable'
  printf '%s\n' "$backup"
  exit 0
fi

say 'restoring the backup into an isolated database to verify it'
check_container="x-zoo-restore-check-$stamp"
image="$(setting NEXT_POSTGRES_IMAGE)"
[ -n "$image" ] || die 'NEXT_POSTGRES_IMAGE is not set'

cleanup() { docker rm -f "$check_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# `--network none`: the verification database can reach nothing, so a dump that
# happens to contain a `COPY … FROM PROGRAM` or a dblink cannot phone anywhere.
# `--tmpfs`: it never touches the host's disk, which on a 2-core box with one
# volume is the disk the live database is on.
docker run -d --name "$check_container" --network none \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_PASSWORD=restore-check -e POSTGRES_DB=restorecheck \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  "$image" >/dev/null

# Wait for it to accept a query, not merely to answer a ping: the official
# image runs a temporary server during init that refuses the configured
# settings, and restoring into that window loses the whole check.
attempt=0
until docker exec "$check_container" psql -U postgres -d restorecheck -c 'select 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 90 ] || die 'the verification database never became usable'
  sleep 2
done

restored_census="$(mktemp)"
live_census="$(mktemp)"
dump_census="$(mktemp)"
# shellcheck disable=SC2064  # expand the paths now: they are what must be removed.
trap "cleanup; rm -f '$restored_census' '$live_census' '$dump_census'" EXIT

if ! gzip -dc "$backup" | docker exec -i "$check_container" \
  psql -v ON_ERROR_STOP=1 -q -U postgres -d restorecheck >/dev/null; then
  die "the backup could not be restored: $backup"
fi

# Sorted bytewise on both sides: PostgreSQL orders by its own collation, and
# `sort` by the locale this shell happens to run in.
psql_q "$row_census_sql" | LC_ALL=C sort >"$live_census" ||
  die 'could not census the live database'
docker exec "$check_container" psql -qtAX -U postgres -d restorecheck -c "$row_census_sql" |
  LC_ALL=C sort >"$restored_census" || die 'could not census the restored database'

census_differs() {
  local what="$1" expected="$2"
  diff -u "$expected" "$restored_census" >/dev/null && return 1
  warn "the restored database does not match $what:"
  diff -u "$expected" "$restored_census" >&2 || true
  return 0
}

if [ -n "$verify_only" ] || [ "$writers_live" -eq 0 ]; then
  # Nothing is writing (or this is somebody's existing dump, which only the
  # live database can vouch for): the dump must hold exactly what is there.
  if census_differs 'the live one' "$live_census"; then
    die "the backup is not a faithful copy: $backup"
  fi
fi

if [ -z "$verify_only" ]; then
  # Every row the dump carries, counted off its own COPY blocks: in COPY's
  # text format a row is exactly one line, and an empty table still gets a
  # block. This is the check that holds while the writers run.
  gzip -dc "$backup" | awk '
    /^COPY public\./ {
      name = $2
      sub(/^public\./, "", name)
      if (name ~ /^".*"$/) { name = substr(name, 2, length(name) - 2); gsub(/""/, "\"", name) }
      rows = 0
      copying = 1
      next
    }
    copying && $0 == "\\." { print name "|" rows; copying = 0; next }
    copying { rows++ }
  ' | LC_ALL=C sort >"$dump_census"
  if census_differs 'the rows the dump carries' "$dump_census"; then
    die "the backup did not restore everything it holds: $backup"
  fi
  if [ "$writers_live" -eq 1 ] &&
    ! diff <(cut -d'|' -f1 "$live_census") <(cut -d'|' -f1 "$restored_census") >/dev/null; then
    warn 'the restored database does not have the tables the live one has:'
    diff <(cut -d'|' -f1 "$live_census") <(cut -d'|' -f1 "$restored_census") >&2 || true
    die "the backup is not a faithful copy: $backup"
  fi
fi

tables="$(wc -l <"$restored_census")"
if [ -z "$verify_only" ] && [ "$writers_live" -eq 1 ]; then
  say "backup verified: $tables table(s) restored with matching row counts (writers running: counted against the dump's own snapshot)"
else
  say "backup verified: $tables table(s) restored with matching row counts"
fi
printf '%s\n' "$backup"
