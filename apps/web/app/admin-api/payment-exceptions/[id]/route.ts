import { paymentAdminExceptionDetail } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../src/server';

/** `/admin-api/payment-exceptions/:id` — everything support needs to call WeChat. */
export const GET = handle(paymentAdminExceptionDetail, (ctx, { params }) =>
  payment.adminExceptionDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
