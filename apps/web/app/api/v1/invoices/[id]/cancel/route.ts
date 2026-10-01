import { invoiceCancel } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/** `/api/v1/invoices/:id/cancel` — the buyer withdraws a request that has not been issued. */
export const POST = handle(invoiceCancel, (ctx, { params }) => orderInvoices.cancel(ctx, params));

export const dynamic = 'force-dynamic';
