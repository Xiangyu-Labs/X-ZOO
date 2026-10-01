import {
  storageCategoryDelete,
  storageCategoryUpdate,
} from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/attachment-categories/:id`.
 *
 * Deleting is refused while the folder still holds files or child folders, and
 * that guard is in the statement rather than in a prior read: two operators may
 * be deleting the folder and filing a picture into it at the same moment.
 */
export const PUT = handle(storageCategoryUpdate, async (ctx, { params, body }) => {
  const category = await storage.categoryUpdate(ctx, params, body);
  ctx.audit(`attachment-category:${params.id}`);
  return category;
});

export const DELETE = handle(storageCategoryDelete, async (ctx, { params }) => {
  await storage.categoryDelete(ctx, params);
  ctx.audit(`attachment-category:${params.id}`);
});

export const dynamic = 'force-dynamic';
