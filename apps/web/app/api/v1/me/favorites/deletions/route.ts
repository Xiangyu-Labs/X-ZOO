import { catalogFavoriteRemoveBatch } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/me/favorites/deletions` — the list screen's 批量取消.
 *
 * A POST sub-resource rather than a DELETE with a body, which not every proxy
 * forwards. App Router prefers the static segment, so this never collides
 * with `/me/favorites/:productId`.
 */

export const POST = handle(catalogFavoriteRemoveBatch, (ctx, { body }) =>
  catalog.favoriteRemoveBatch(ctx, body),
);

export const dynamic = 'force-dynamic';
