import { invoiceAdminList } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../src/server';

/** `/admin-api/order-invoices` — the 开票申请 queue. */
export const GET = handle(invoiceAdminList, (ctx, { query }) =>
  orderInvoices.adminList(ctx, query),
);

export const dynamic = 'force-dynamic';
