import { userAdminApproveCancellation } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/**
 * `POST /admin-api/user-cancellations/:id/approval` — 同意注销.
 *
 * Anonymises the account and revokes its sessions. Never a hard delete: orders,
 * refunds and invoices reference the id, and a cascade would erase a paying
 * customer's purchase history.
 */
export const POST = handle(userAdminApproveCancellation, async (ctx, { params, body }) => {
  const decided = await user.adminApproveCancellation(ctx, params, body);
  ctx.audit(`user-cancellation:${params.id}`);
  return decided;
});

export const dynamic = 'force-dynamic';
