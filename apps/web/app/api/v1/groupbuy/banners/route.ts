import { groupbuyBanners } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/** `/api/v1/groupbuy/banners` — the channel head images, held in config. */
export const GET = handle(groupbuyBanners, (ctx) => groupbuy.banners(ctx));

export const dynamic = 'force-dynamic';
