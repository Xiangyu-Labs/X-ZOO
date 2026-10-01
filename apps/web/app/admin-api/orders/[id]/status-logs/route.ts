import { orderAdminTimeline } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/orders/:id/status-logs` — the timeline, newest first. */
export const GET = handle(orderAdminTimeline, (ctx, { params }) =>
  orderConsole.adminTimeline(ctx, params),
);

export const dynamic = 'force-dynamic';
