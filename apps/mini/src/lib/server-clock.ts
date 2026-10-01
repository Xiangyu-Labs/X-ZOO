import type { Transport } from '@shop/api-client';

/**
 * The server's clock, as far as this phone knows it (design.md §4.4 Countdown: never trust the
 * phone's time for a deadline). `offset` = server − phone, in ms; 0 until something reports the
 * server's time.
 *
 * Fed by `app/config`: its `serverTime` on a 200 (src/app-config), and its `X-Server-Time`
 * header on every answer — a 304 has no body — through `serverClockTransport`.
 */
let offset = 0;

/** Records the server's time; a value that is not a finite instant is ignored. */
export function setServerTime(serverMs: number, receivedAtMs: number = Date.now()): void {
  if (!Number.isFinite(serverMs) || !Number.isFinite(receivedAtMs)) return;
  offset = serverMs - receivedAtMs;
}

/** Now, on the server's clock. Countdowns and deadlines read this, never `Date.now()`. */
export function serverNow(): number {
  return Date.now() + offset;
}

/** Response header with the server's time (ISO-8601), lower-cased as transports report it. */
export const SERVER_TIME_HEADER = 'x-server-time';

/** Wraps the platform transport: any answer carrying `X-Server-Time` sets the clock. */
export function serverClockTransport(inner: Transport): Transport {
  return async (request) => {
    const response = await inner(request);
    const stamp = response.headers[SERVER_TIME_HEADER];
    if (stamp) setServerTime(Date.parse(stamp));
    return response;
  };
}
