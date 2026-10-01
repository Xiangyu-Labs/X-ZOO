import { ADMIN_COOKIE, getContainer, readCookie } from '../../../../src/server';
import { serveAdminNotificationStream } from './_stream';

/**
 * `/admin-api/notifications/stream` — the header bell's SSE feed.
 *
 * ## Why this is a bare route handler
 *
 * `handle()` validates a response against a zod schema and serialises it as
 * JSON. An SSE response is a `text/event-stream` body that never ends, so it
 * cannot be modelled by a `RouteDef` and cannot go through `handle` — the same
 * reason the bell's hook uses a raw `EventSource` instead of `callRoute`. It is
 * one of very few bare handlers, and it repeats only
 * the cookie lookup, not the authorisation rules.
 *
 * ## What it does not do
 *
 * It does **not** decide who may see what. The fan-out already resolved the
 * recipients against each event's permission atom (`findAdminRecipients`) and
 * published to those admins' channels only, so an operator without
 * `refund:request:read` has nothing on their channel to filter out. A filter
 * here would be a second place to get the same rule right.
 *
 * ## Keep-alive
 *
 * A comment line every 25 seconds. Without it a proxy with a 30 s idle timeout
 * closes the connection, the browser reconnects, and a shop behind nginx sees a
 * reconnect storm that looks exactly like an outage.
 */

const KEEPALIVE_MS = 25_000;

/**
 * The session is re-checked on every keep-alive tick and the stream closes
 * when it no longer resolves; every stream in the process shares one Redis
 * subscriber, and an admin may hold at most `MAX_STREAMS_PER_ADMIN`.
 * The stream lives in `_stream.ts` so a test can shorten the tick.
 */
export async function GET(request: Request): Promise<Response> {
  const token = readCookie(request, ADMIN_COOKIE);
  const session = token ? await getContainer().adminAuth.resolve(token) : null;
  return serveAdminNotificationStream(
    request,
    token && session ? { token, adminId: session.adminId } : null,
    { keepaliveMs: KEEPALIVE_MS },
  );
}

export const dynamic = 'force-dynamic';
