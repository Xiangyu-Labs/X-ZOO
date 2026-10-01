import {
  groupbuyAdminActivityDelete,
  groupbuyAdminActivityDetail,
  groupbuyAdminActivityUpdate,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../src/server';

/** `/admin-api/groupbuy-activities/:id` — read, edit, soft-delete one campaign. */
export const GET = handle(groupbuyAdminActivityDetail, (ctx, { params }) =>
  groupbuy.adminActivityDetail(ctx, params),
);

export const PUT = handle(groupbuyAdminActivityUpdate, async (ctx, { params, body }) => {
  const updated = await groupbuy.adminActivityUpdate(ctx, params, body);
  ctx.audit(`groupbuy-activity:${params.id}`);
  return updated;
});

export const DELETE = handle(groupbuyAdminActivityDelete, async (ctx, { params }) => {
  await groupbuy.adminActivityDelete(ctx, params);
  ctx.audit(`groupbuy-activity:${params.id}`);
});

export const dynamic = 'force-dynamic';
