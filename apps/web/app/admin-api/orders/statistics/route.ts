import { orderAdminStatistics } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../src/server';

/** `/admin-api/orders/statistics` — the work-queue counters and the window totals. */
export const GET = handle(orderAdminStatistics, (ctx, { query }) =>
  orderConsole.adminStatistics(ctx, query),
);

export const dynamic = 'force-dynamic';
