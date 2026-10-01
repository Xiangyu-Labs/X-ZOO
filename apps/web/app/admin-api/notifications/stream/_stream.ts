import { commonErrors } from '@shop/contracts/conventions';
import { AdminStreamLimitError, subscribeToAdmin } from '@shop/core/notification';
import { getContainer } from '../../../../src/server';

/**
 * The bell's SSE stream, split from `route.ts` so a test can shorten the
 * keep-alive (a route file may export only handlers). See `route.ts` for why
 * this is a bare handler and not `handle()`.
 *
 * ## The session is re-checked on every keep-alive
 *
 * The cookie used to be resolved once, at connect, and the stream then
 * forwarded that admin's channel until the client went away — so a password
 * change or a disable (every session revoked) did not reach a stream that was
 * already open. Each keep-alive tick now reads the session again (`peek`: it
 * does not slide the TTL, so an open tab does not keep an idle admin signed in)
 * and closes the stream when it no longer resolves to the same admin.
 *
 * ## One Redis connection per process, and a per-admin cap
 *
 * `subscribeToAdmin` shares one subscriber connection across every stream in
 * the process, and refuses an admin's stream beyond `MAX_STREAMS_PER_ADMIN`
 * with a 429 — which an `EventSource` treats as final, so a refused tab does
 * not retry in a loop.
 */

export interface AdminNotificationStreamOptions {
  /** A comment line this often, and a session re-check with it. */
  keepaliveMs: number;
  /** Override for tests; defaults to `MAX_STREAMS_PER_ADMIN`. */
  maxPerAdmin?: number;
}

/** The session the route resolved at connect, with the cookie it came from. */
export interface StreamSession {
  token: string;
  adminId: number;
}

/**
 * Serves the stream for a session `route.ts` has already resolved (the route
 * keeps the resolve in its own body, which is what `pnpm guards`' contracts
 * check looks for in a bare handler). `null` answers 401.
 */
export async function serveAdminNotificationStream(
  request: Request,
  session: StreamSession | null,
  options: AdminNotificationStreamOptions,
): Promise<Response> {
  const container = getContainer();
  if (!session) return refusal('UNAUTHENTICATED');
  const { token } = session;

  const adminId = session.adminId;
  const encoder = new TextEncoder();

  let unsubscribe: (() => Promise<void>) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  // Subscribe before building the response, so a refusal is an ordinary
  // status code rather than a stream that closes at once.
  let forward: (payload: string) => void = () => undefined;
  try {
    unsubscribe = await subscribeToAdmin(
      container.redis,
      adminId,
      (payload) => forward(payload),
      options.maxPerAdmin === undefined ? {} : { maxPerAdmin: options.maxPerAdmin },
    );
  } catch (error) {
    if (error instanceof AdminStreamLimitError) {
      container.logger.warn({ adminId }, 'notification stream refused: too many open');
      return refusal('RATE_LIMITED');
    }
    container.logger.error({ err: error, adminId }, 'notification stream subscribe failed');
    return refusal('INTERNAL');
  }

  async function cleanup(controller: ReadableStreamDefaultController<Uint8Array> | null) {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    if (unsubscribe) await unsubscribe().catch(() => undefined);
    try {
      controller?.close();
    } catch {
      // Already closed by the runtime; nothing to do.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between the check and the enqueue.
          void cleanup(null);
        }
      };

      // Tells the browser to wait 5 s before reconnecting, and gives the
      // proxy something to flush so the connection is established at once.
      send(`retry: 5000\n\n`);

      // The payload is already the JSON the bell parses; forwarding it
      // verbatim is what keeps the bell and the inbox showing one thing.
      forward = (payload) => send(`event: notification\ndata: ${payload}\n\n`);

      keepalive = setInterval(() => {
        void (async () => {
          const current = await container.adminAuth.peek(token).catch(() => null);
          if (!current || current.adminId !== adminId) {
            container.logger.info({ adminId }, 'notification stream closed: session gone');
            await cleanup(controller);
            return;
          }
          send(': keepalive\n\n');
        })();
      }, options.keepaliveMs);

      request.signal.addEventListener('abort', () => {
        void cleanup(controller);
      });
    },

    async cancel() {
      await cleanup(null);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx buffers `text/event-stream` by default, which holds every
      // event until the buffer fills — i.e. forever, for a 200-byte bell.
      'x-accel-buffering': 'no',
    },
  });
}

function refusal(code: 'UNAUTHENTICATED' | 'RATE_LIMITED' | 'INTERNAL'): Response {
  const { status, message } = commonErrors[code];
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
