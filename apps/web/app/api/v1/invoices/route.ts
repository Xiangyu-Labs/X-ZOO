import { invoiceMyList } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoices } from '@shop/core/order';
import { handle } from '../../../../src/server';

/** `/api/v1/invoices` — 我的发票. */
export const GET = handle(invoiceMyList, (ctx, { query }) => orderInvoices.myList(ctx, query));

export const dynamic = 'force-dynamic';
