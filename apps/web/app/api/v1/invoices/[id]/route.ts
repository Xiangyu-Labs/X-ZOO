import { invoiceMyDetail } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/api/v1/invoices/:id`. A stranger's invoice and a missing one are the same answer. */
export const GET = handle(invoiceMyDetail, (ctx, { params }) =>
  orderInvoices.myDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
