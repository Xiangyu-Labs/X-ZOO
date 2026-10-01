import { groupbuyAdminActivitySetStatus } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/** `/admin-api/groupbuy-activities/:id/status` — 上架 / 暂停 / 结束. */
export const POST = handle(groupbuyAdminActivitySetStatus, async (ctx, { params, body }) => {
  const updated = await groupbuy.adminActivitySetStatus(ctx, params, body);
  ctx.audit(`groupbuy-activity:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
