import {
  storageCategoryCreate,
  storageCategoryTree,
} from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../src/server';

/**
 * `/admin-api/attachment-categories` — the media library's folders.
 *
 * The tree comes back flat, in depth-first display order, with `depth` and
 * `path` on every row; the client indents rather than recursing.
 */
export const GET = handle(storageCategoryTree, (ctx) => storage.categoryTree(ctx));

export const POST = handle(storageCategoryCreate, async (ctx, { body }) => {
  const category = await storage.categoryCreate(ctx, body);
  ctx.audit(`attachment-category:${category.id}`);
  return category;
});

export const dynamic = 'force-dynamic';
