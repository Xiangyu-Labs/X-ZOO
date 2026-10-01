import { orderAdminExport } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/orders/exports` — CSV text inside the JSON envelope.
 *
 * `handle()` validates every response against its contract, so a route cannot
 * answer with a binary stream; the kit turns `content` into a download on the
 * client.
 */
export const GET = handle(orderAdminExport, async (ctx, { query }) => {
  const result = await orderConsole.adminExport(ctx, query);
  // A CSV of every buyer's name, phone and address leaves the building; the
  // audit log should say who took it.
  ctx.audit(`order-export:${result.rowCount}`);
  return result;
});

export const dynamic = 'force-dynamic';
