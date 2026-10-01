import type { Transport, TransportRequest } from '@shop/api-client';

export interface RenewalHooks {
  /**
   * The token to send again a request that went out with `sent` and met a 401, renewing the
   * session if that is what it takes; `null` to let the 401 stand. The session decides, so a
   * request is replayed only as the account that sent it (session.ts `renewFor`, AUTH-010).
   */
  renew: (sent: string) => Promise<string | null>;
}

function bearer(request: TransportRequest): string | null {
  const header = request.headers['Authorization'] ?? request.headers['authorization'];
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function withToken(request: TransportRequest, token: string): TransportRequest {
  const headers = { ...request.headers };
  delete headers['authorization'];
  headers['Authorization'] = `Bearer ${token}`;
  return { ...request, headers };
}

/**
 * Wraps the build's transport so a request that fails with 401 because its token expired is
 * renewed and replayed **once**, reads and writes alike (auth.md「401：续期」). Without this a
 * mutation that met an expired token was simply lost.
 *
 * - Only a request that carried a token is renewed; a 401 without one is an answer.
 * - A request whose token is already stale (another request renewed meanwhile) is replayed
 *   with the current token, without a second renewal — if it is the same account's.
 * - Renewal failing (phone-required, WeChat down, 403), or reaching another account than the
 *   one that sent the request (AUTH-010), returns the original 401: the client raises it and
 *   the session stops there; nothing loops, and nothing runs as the other account.
 * - The replay's answer, 401 included, is final.
 */
export function renewingTransport(inner: Transport, hooks: RenewalHooks): Transport {
  return async (request) => {
    const response = await inner(request);
    if (response.status !== 401) return response;
    const sent = bearer(request);
    if (!sent) return response;

    const token = await hooks.renew(sent);
    if (!token || token === sent) return response;
    return inner(withToken(request, token));
  };
}
