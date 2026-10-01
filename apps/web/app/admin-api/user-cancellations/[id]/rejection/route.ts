import { userAdminRejectCancellation } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `POST /admin-api/user-cancellations/:id/rejection` — 驳回, with a reason. */
export const POST = handle(userAdminRejectCancellation, async (ctx, { params, body }) => {
  const decided = await user.adminRejectCancellation(ctx, params, body);
  ctx.audit(`user-cancellation:${params.id}`);
  return decided;
});

export const dynamic = 'force-dynamic';
