/**
 * The answer to an `/api/v1/*` or `/admin-api/*` URL that no route serves.
 *
 * Without it Next answered those with its HTML 404 page, and a client parsing
 * the error envelope got markup instead: the mini-program showed a generic
 * failure, and a caller could not tell "no such endpoint" from an outage.
 * `next.config.ts` sends unmatched API URLs here through a *fallback* rewrite,
 * which applies only after every real route has had its chance.
 *
 * It lives outside `app/api` and `app/admin-api` on purpose: it is not an
 * endpoint and has no contract, and the `contracts` guard (which describes
 * those two trees) has nothing to say about it.
 */

function notFound(): Response {
  return new Response(JSON.stringify({ code: 'NOT_FOUND', message: '资源不存在' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const dynamic = 'force-dynamic';
