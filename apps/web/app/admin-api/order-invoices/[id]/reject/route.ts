import { invoiceAdminReject } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/order-invoices/:id/reject` — 驳回. The reason is required; the buyer is told it. */
export const POST = handle(invoiceAdminReject, async (ctx, { params, body }) => {
  const invoice = await orderInvoices.adminReject(ctx, params, body);
  ctx.audit(`order-invoice:${params.id}`);
  return invoice;
});

export const dynamic = 'force-dynamic';
