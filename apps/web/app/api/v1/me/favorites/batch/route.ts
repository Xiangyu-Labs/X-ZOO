import { catalogFavoriteAddBatch } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/api/v1/me/favorites/batch` — 批量收藏. */
export const POST = handle(catalogFavoriteAddBatch, (ctx, { body }) =>
  catalog.favoriteAddBatch(ctx, body),
);

export const dynamic = 'force-dynamic';
