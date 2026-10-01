import { refundHide, refundMyDetail } from '@shop/contracts/refund/refund.storefront.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/refunds/:id` — one after-sales request.
 *
 * DELETE hides the row from the shopper's list. It never deletes anything: a
 * settled refund is a money record, and the buyer's list is a view of it.
 */
export const GET = handle(refundMyDetail, (ctx, { params }) => refund.myDetail(ctx, params));

export const DELETE = handle(refundHide, (ctx, { params }) => refund.hide(ctx, params));

export const dynamic = 'force-dynamic';
