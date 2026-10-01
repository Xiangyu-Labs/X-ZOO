import {
  catalogFavoriteAdd,
  catalogFavoriteList,
} from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/api/v1/me/favorites` — 我的收藏. */

export const GET = handle(catalogFavoriteList, (ctx, { query }) =>
  catalog.favoriteList(ctx, query),
);

export const POST = handle(catalogFavoriteAdd, (ctx, { body }) => catalog.favoriteAdd(ctx, body));

export const dynamic = 'force-dynamic';
