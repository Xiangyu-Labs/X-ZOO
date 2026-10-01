import { refundCancel } from '@shop/contracts/refund/refund.storefront.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/refunds/:id/cancel` — 撤销申请.
 *
 * Racing an operator's approval is decided by one conditional update, so the
 * loser reads `REFUND_NOT_ACTIONABLE` rather than both sides half-winning.
 */
export const POST = handle(refundCancel, (ctx, { params }) => refund.cancel(ctx, params));

export const dynamic = 'force-dynamic';
