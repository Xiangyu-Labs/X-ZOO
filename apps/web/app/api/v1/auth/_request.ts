import type { RequestMeta } from '@shop/core/user';
import { clientIp } from '@/server/request-meta';

export { clientIp };

/**
 * What the sign-in services want to know about the caller, read off the request.
 *
 * The address is `clientIp()`: the `X-Real-IP` the edge sets from its own view
 * of the peer, never a header the client wrote (see
 * `src/server/request-meta.ts`). The throttle keys still pair it with the
 * account wherever they can, never the address alone.
 */
export function requestMeta(request: Request): RequestMeta {
  return { ip: clientIp(request), userAgent: request.headers.get('user-agent') };
}

/** The opaque storefront token, for the one route that revokes it by value. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
