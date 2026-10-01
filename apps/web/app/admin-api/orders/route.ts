import { orderAdminList } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../src/server';

/**
 * `/admin-api/orders` — the console list.
 *
 * Every filter is its own query key (`status`, `fulfillmentStatus`,
 * `refundStatus`, …) rather than one packed integer, so the tab bar
 * is a preset over them and 已退款 + 待收货 can be asked for at once.
 */
export const GET = handle(orderAdminList, (ctx, { query }) => orderConsole.adminList(ctx, query));

export const dynamic = 'force-dynamic';
