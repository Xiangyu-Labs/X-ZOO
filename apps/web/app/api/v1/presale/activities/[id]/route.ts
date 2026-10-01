import { presaleDetailRoute } from '@shop/contracts/presale/presale.storefront.contract';
import * as presale from '@shop/core/presale';
import { handle } from '../../../../../../src/server';

/** `/api/v1/presale/activities/:id` — the campaign page's data. */
export const GET = handle(presaleDetailRoute, (ctx, { params }) => presale.detail(ctx, params));

export const dynamic = 'force-dynamic';
