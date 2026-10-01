import { createHash, randomBytes } from 'node:crypto';

import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';

/**
 * Preview tokens (DECOR-012).
 *
 * An admin previews a draft on a real device through
 * `GET /api/v1/pages/:id?previewToken=…`, a storefront route with no admin
 * session behind it. The token is the whole credential, so it is:
 *
 * - **opaque and unguessable**: 256 random bits, base64url;
 * - **scoped**: it opens the draft of the one document it was issued for, and
 *   nothing else — not another document, not a write;
 * - **short-lived**: Redis forgets it after `PREVIEW_TOKEN_SECONDS`;
 * - **stored hashed**: Redis holds the SHA-256 of the token, so a dump of the
 *   cache hands out no working link.
 *
 * Opaque rather than signed: the environment carries no signing secret for
 * this, and a Redis entry can be revoked or listed, which a signature cannot.
 */
export const PREVIEW_TOKEN_SECONDS = 10 * 60;

function keyOf(token: string): string {
  return `decor:preview:${createHash('sha256').update(token).digest('hex')}`;
}

export async function issuePreviewToken(
  ctx: Ctx,
  documentId: number,
): Promise<{ previewToken: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  await ctx.redis.set(keyOf(token), String(documentId), 'EX', PREVIEW_TOKEN_SECONDS);
  const expiresAt = new Date(ctx.clock.now().getTime() + PREVIEW_TOKEN_SECONDS * 1000);
  return { previewToken: token, expiresAt: expiresAt.toISOString() };
}

/** Throws `DECOR_PREVIEW_TOKEN_INVALID` unless `token` is live and was issued for `documentId`. */
export async function assertPreviewToken(
  ctx: Ctx,
  documentId: number,
  token: string,
): Promise<void> {
  const stored = await ctx.redis.get(keyOf(token));
  if (stored === null || stored !== String(documentId)) {
    throw new DomainError('DECOR_PREVIEW_TOKEN_INVALID');
  }
}
