import { groupbuyPosterRoute } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../../../src/server';

/**
 * `/api/v1/groupbuy/groups/:id/poster` — poster *data*.
 *
 * The fields and a `qrPayload`; the client draws the image. Rendering a PNG on
 * the API server and caching it on disk would be a rendering farm nobody asked
 * for.
 */
export const GET = handle(groupbuyPosterRoute, (ctx, { params }) => groupbuy.poster(ctx, params));

export const dynamic = 'force-dynamic';
