import { groupbuyAdminGroupComplete } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/groupbuy-groups/:id/completion` — 立即成团.
 *
 * Its own permission atom (`groupbuy:group:complete`), and never on an
 * under-filled team: 虚拟成团 is off for good, so the service refuses to invent
 * members.
 */
export const POST = handle(groupbuyAdminGroupComplete, async (ctx, { params, body }) => {
  const group = await groupbuy.adminGroupComplete(ctx, params, body);
  ctx.audit(`groupbuy-group:${params.id}`);
  return group;
});

export const dynamic = 'force-dynamic';
