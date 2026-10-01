import { invoiceAdminDetail } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../src/server';

/** `/admin-api/order-invoices/:id` — one request, with the header as the buyer froze it. */
export const GET = handle(invoiceAdminDetail, (ctx, { params }) =>
  orderInvoices.adminDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
