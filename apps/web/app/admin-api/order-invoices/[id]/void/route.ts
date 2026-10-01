import { invoiceAdminVoid } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/order-invoices/:id/void` — 作废 an issued invoice once it has been reversed (冲红)
 * in the tax system. Only the record changes; the number is kept.
 */
export const POST = handle(invoiceAdminVoid, async (ctx, { params }) => {
  const invoice = await orderInvoices.adminVoid(ctx, params);
  ctx.audit(`order-invoice:${params.id}`);
  return invoice;
});

export const dynamic = 'force-dynamic';
