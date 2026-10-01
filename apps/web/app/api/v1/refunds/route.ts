import { refundApply, refundMyList } from '@shop/contracts/refund/refund.storefront.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/refunds` — 我的售后单, and applying for one.
 *
 * The POST body carries lines and quantities and **no amount**: the service
 * computes the money from the frozen order lines, so a crafted body cannot ask
 * for more than was paid.
 */
export const GET = handle(refundMyList, (ctx, { query }) => refund.myList(ctx, query));

export const POST = handle(refundApply, (ctx, { body }) => refund.apply(ctx, body));

export const dynamic = 'force-dynamic';
