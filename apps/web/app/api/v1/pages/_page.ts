import { createHash } from 'node:crypto';

// Shared by the three `/api/v1/pages` routes. `X-Client-Version` arrives
// parsed, as `ctx.clientVersion`; the resolver reads a missing or garbled
// one as "serve every block".

/**
 * The page's entity tag: a hash of everything but `resolvedAt`, so an
 * unchanged page — same layout, same data, same personal state — answers 304
 * even though it was re-resolved.
 */
export function pageEtag(page: { resolvedAt: string }): string {
  const { resolvedAt: _resolvedAt, ...rest } = page;
  return createHash('sha256').update(JSON.stringify(rest)).digest('base64url').slice(0, 27);
}
