import { invoiceRequest } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/orders/:id/invoice` — 申请开票.
 *
 * One live request per order, enforced by the partial unique index
 * `order_invoices_open_uq` rather than by a prior SELECT, so a double-tap is a
 * constraint violation and not a second row.
 */
export const POST = handle(invoiceRequest, (ctx, { params, body }) =>
  orderInvoices.request(ctx, params, body),
);

export const dynamic = 'force-dynamic';
