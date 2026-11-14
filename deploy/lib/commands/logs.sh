#!/usr/bin/env bash
# A service's log, across every release.
#
#   shop logs <service> [--since <time>] [--until <time>] [--grep <text>] [-f]
#
# Reads the host's journal, where compose.yml sends every container's output
# (the `journald` log driver). An upgrade or a rollback recreates the
# containers, and `shop compose logs` shows only the current container's; this
# shows the service's lines from before those too, for as long as the journal
# keeps them ("Logs" in deploy/README.md).
#
#   --since, --until  anything journalctl takes, in Asia/Shanghai time:
#                     "2026-11-14 09:30", "3 days ago", "yesterday".
#                     Default: the last 24 hours.
#   --grep <text>     only the lines holding this text, e.g. the 请求编号 that
#                     the admin's 操作日志 shows for a failed operation.
#   -f                keep printing new lines.
#
# Read-only. Exit codes: 0 printed · 1 the journal cannot be read · 2 misuse.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
. "$here/../common.sh"

service=''
since='24 hours ago'
until=''
pattern=''
follow=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      sed -n '2,19p' "$0"
      exit 0
      ;;
    --since | --until | --grep)
      [ "$#" -ge 2 ] || {
        warn "$1 needs a value"
        exit 2
      }
      case "$1" in
        --since) since="$2" ;;
        --until) until="$2" ;;
        --grep) pattern="$2" ;;
      esac
      shift
      ;;
    -f | --follow) follow=1 ;;
    -*)
      warn "unknown argument: $1"
      exit 2
      ;;
    *)
      [ -z "$service" ] || {
        warn "one service at a time: $service or $1"
        exit 2
      }
      service="$1"
      ;;
  esac
  shift
done

case " $APP_SERVICES $DATA_SERVICES migrate " in
  *" ${service:--} "*) ;;
  *)
    warn "usage: shop logs <service> [--since <time>] [--until <time>] [--grep <text>] [-f]"
    warn "  services: $APP_SERVICES $DATA_SERVICES migrate"
    exit 2
    ;;
esac

require_settings
command -v journalctl >/dev/null || die "journalctl is not on this host; the logs are in the systemd journal"

journal_readable || die "cannot read the journal as $(id -un): add the user to the systemd-journal group"

mapfile -t match < <(journal_match "$service")
args=(--no-pager --output cat "${match[@]}" --since "$since")
[ -z "$until" ] || args+=(--until "$until")
[ -z "$follow" ] || args+=(--follow)

if [ -n "$pattern" ]; then
  shop_journalctl "${args[@]}" | grep --line-buffered -F -- "$pattern" || true
else
  shop_journalctl "${args[@]}"
fi
