import { catalogFavoriteRemove } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/api/v1/me/favorites/:productId` — un-favourite one product. */

export const DELETE = handle(catalogFavoriteRemove, (ctx, { params }) =>
  catalog.favoriteRemove(ctx, params),
);

export const dynamic = 'force-dynamic';
