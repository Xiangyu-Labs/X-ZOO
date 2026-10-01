import {
  couponAdminDelete,
  couponAdminDetail,
  couponAdminUpdate,
} from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../src/server';

/** `/admin-api/coupons/:id` — read, edit, soft-delete one campaign. */
export const GET = handle(couponAdminDetail, (ctx, { params }) => coupon.adminDetail(ctx, params));

export const PUT = handle(couponAdminUpdate, async (ctx, { params, body }) => {
  const updated = await coupon.adminUpdate(ctx, params, body);
  ctx.audit(`coupon:${params.id}`);
  return updated;
});

export const DELETE = handle(couponAdminDelete, async (ctx, { params }) => {
  await coupon.adminDelete(ctx, params);
  ctx.audit(`coupon:${params.id}`);
});

export const dynamic = 'force-dynamic';
