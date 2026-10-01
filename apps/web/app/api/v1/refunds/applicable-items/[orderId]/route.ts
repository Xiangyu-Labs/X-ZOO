import { refundApplicableItems } from '@shop/contracts/refund/refund.storefront.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/refunds/applicable-items/:orderId` — the apply screen in one call.
 *
 * A static segment before the dynamic one, so it never collides with
 * `/api/v1/refunds/:id`.
 */
export const GET = handle(refundApplicableItems, (ctx, { params }) =>
  refund.applicableItems(ctx, params),
);

export const dynamic = 'force-dynamic';
