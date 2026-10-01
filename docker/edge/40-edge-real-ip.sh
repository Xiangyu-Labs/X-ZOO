#!/bin/sh
# Writes the edge's trusted-proxy list. Run by the nginx image's
# `/docker-entrypoint.sh` before nginx starts, like the image's own
# `/docker-entrypoint.d/*.sh` hooks; a non-zero exit stops the container.
#
# The trust boundary: nginx's realip module takes the client address from
# `X-Forwarded-For` only when the TCP peer is one of these networks, and the
# edge then sends `X-Real-IP` / `X-Forwarded-For` upstream as that single
# address — the app reads `X-Real-IP` and nothing else. Anyone else's
# `X-Forwarded-For` is ignored, because it is whatever the client wrote.
#
#   NEXT_EDGE_TRUSTED_PROXIES   space- or comma-separated addresses / CIDRs of
#                               the front proxy (Traefik's network, from
#                               `docker network inspect server-internal-net`).
#                               Empty: nothing is trusted and the TCP peer is
#                               the client — right for an edge nobody fronts.
#
# Refused, so the container does not start with it:
#   - anything but hex digits, dots, colons and one slash per entry (the value
#     is written into nginx config, so it must not be able to carry any);
#   - `0.0.0.0/0`, `::/0` and other zero-length prefixes: trusting every peer
#     is exactly the client-picks-its-own-address hole this closes.
#
# nginx itself then validates each address when it loads the file.

set -eu

out=/etc/nginx/edge/real-ip.conf
tmp="$out.tmp"
list="$(printf '%s' "${NEXT_EDGE_TRUSTED_PROXIES:-}" | tr ',' ' ')"

refuse() {
  printf '40-edge-real-ip.sh: NEXT_EDGE_TRUSTED_PROXIES: %s\n' "$1" >&2
  exit 1
}

{
  printf '# Written at container start by 40-edge-real-ip.sh from NEXT_EDGE_TRUSTED_PROXIES.\n'
  for entry in $list; do
    case "$entry" in
      *[!0-9A-Fa-f.:/]* | */*/* | /* | */ | */*[!0-9]*) refuse "'$entry' is not an address or CIDR" ;;
    esac
    case "$entry" in
      */*)
        if [ "${entry#*/}" -eq 0 ]; then
          refuse "'$entry' trusts every peer; name the front proxy's network instead"
        fi
        ;;
    esac
    printf 'set_real_ip_from %s;\n' "$entry"
  done
} >"$tmp"
mv "$tmp" "$out"

count="$(grep -c '^set_real_ip_from' "$out" || true)"
if [ "$count" -eq 0 ]; then
  printf '40-edge-real-ip.sh: no trusted proxy; the TCP peer is the client address\n'
else
  printf '40-edge-real-ip.sh: X-Forwarded-For trusted from %s network(s)\n' "$count"
fi
