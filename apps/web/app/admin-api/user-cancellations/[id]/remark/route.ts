import { userAdminRemarkCancellation } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `POST /admin-api/user-cancellations/:id/remark` — a note without deciding yet. */
export const POST = handle(userAdminRemarkCancellation, async (ctx, { params, body }) => {
  const updated = await user.adminRemarkCancellation(ctx, params, body);
  ctx.audit(`user-cancellation:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
