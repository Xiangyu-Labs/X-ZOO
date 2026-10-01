import type { Ctx } from '../kernel/context';

/**
 * The public part of a resolved page, cached per revision (DECOR-014).
 *
 * The key names the revision, and the storefront looks up which revision is
 * live in the database on every request (one indexed read). A publish or a
 * rollback therefore makes the old entry unreachable at once — "invalidated on
 * publish" by construction — and the publish also deletes it, so it does not
 * linger. The TTL is short because the *data* in the entry (prices, stock,
 * campaigns) changes without any publish.
 *
 * Never throws: a Redis that is unwell costs a rebuild, never a page.
 */
export const DECOR_CACHE_SECONDS = 60;

export function revisionCacheKey(revisionId: number): string {
  return `decor:page:rev:${revisionId}`;
}

export async function readCachedPage<T>(ctx: Ctx, revisionId: number): Promise<T | null> {
  try {
    const raw = await ctx.redis.get(revisionCacheKey(revisionId));
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch (error) {
    ctx.logger.warn({ err: error, revisionId }, 'decor: page cache read failed');
    return null;
  }
}

export async function writeCachedPage(ctx: Ctx, revisionId: number, page: unknown): Promise<void> {
  try {
    await ctx.redis.set(
      revisionCacheKey(revisionId),
      JSON.stringify(page),
      'EX',
      DECOR_CACHE_SECONDS,
    );
  } catch (error) {
    ctx.logger.warn({ err: error, revisionId }, 'decor: page cache write failed');
  }
}

export async function dropCachedPage(ctx: Ctx, revisionId: number | null): Promise<void> {
  if (revisionId === null) return;
  try {
    await ctx.redis.del(revisionCacheKey(revisionId));
  } catch (error) {
    ctx.logger.warn({ err: error, revisionId }, 'decor: page cache invalidation failed');
  }
}
