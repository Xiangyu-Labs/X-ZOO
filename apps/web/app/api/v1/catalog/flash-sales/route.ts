import { catalogFlashSaleList } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/catalog/flash-sales` — 限时秒杀 on now: the 秒杀 list page, and a
 * DIY 限时秒杀 block's picked products when `productIds` is given.
 *
 * Public and not personalised. Buying at the 秒杀价 is ordinary checkout.
 */
export const GET = handle(catalogFlashSaleList, (ctx, { query }) =>
  catalog.flashSaleList(ctx, query),
);

export const dynamic = 'force-dynamic';
