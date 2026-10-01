import { invoiceAdminIssue } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/order-invoices/:id/issue` — 开票.
 *
 * `order_invoices_issued_shape` requires the number and the timestamp
 * together, so there is no such thing here as an issued invoice nobody can
 * look up. The e-invoice provider stays out of scope; an operator types the
 * number from whatever system actually issued it.
 */
export const POST = handle(invoiceAdminIssue, async (ctx, { params, body }) => {
  const invoice = await orderInvoices.adminIssue(ctx, params, body);
  ctx.audit(`order-invoice:${params.id}`);
  return invoice;
});

export const dynamic = 'force-dynamic';
