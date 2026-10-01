import { refundReasons } from '@shop/contracts/refund/refund.storefront.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../src/server';

/** `/api/v1/refund-reasons` — the canned list the apply screen offers. */
export const GET = handle(refundReasons, () => refund.refundReasons());

export const dynamic = 'force-dynamic';
