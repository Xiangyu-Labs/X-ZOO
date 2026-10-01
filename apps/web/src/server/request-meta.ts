import { isIP } from 'node:net';

/**
 * The caller's address, as the edge saw it.
 *
 * The trust boundary is the edge (`docker/edge/nginx.conf`): nginx's
 * realip module takes the client address from `X-Forwarded-For` **only** when
 * the peer is the configured front proxy (Traefik's network,
 * `NEXT_EDGE_TRUSTED_PROXIES`), and the edge then *sets* `X-Real-IP` to that
 * address, overwriting whatever the client sent. So this reads `X-Real-IP` and
 * nothing else.
 *
 * It used to read the first `X-Forwarded-For` entry — the one the client
 * writes. The edge appended to the client's header rather than replacing it, so
 * any caller could pick its own address: a fresh per-IP SMS budget per request,
 * 访客数 at will, and whatever `last_login_ip` or audit IP it liked.
 *
 * A value that is not an IP address is refused rather than stored: the header
 * is only ever the edge's `$remote_addr`, and anything else means the request
 * did not come through it (a dev server, a test) — `null` is the honest answer.
 */
export function clientIp(request: Request): string | null {
  const value = request.headers.get('x-real-ip')?.trim() ?? '';
  return isIP(value) === 0 ? null : value;
}
