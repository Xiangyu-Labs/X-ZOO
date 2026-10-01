import { presaleList } from '@shop/contracts/presale/presale.storefront.contract';
import * as presale from '@shop/core/presale';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/presale/activities` — the 预售频道 list, and a DIY 预售 component's
 * picked activities when `ids` is given; `presale.list` decides which.
 *
 * Public: nothing here is personalised, so the same response serves every
 * visitor. There is no "buy" endpoint next to it — buying a presale item is
 * `POST /api/v1/orders` with `kind: 'presale'` and `kindMeta: { activityId }`.
 */
export const GET = handle(presaleList, (ctx, { query }) => presale.list(ctx, query));

export const dynamic = 'force-dynamic';
