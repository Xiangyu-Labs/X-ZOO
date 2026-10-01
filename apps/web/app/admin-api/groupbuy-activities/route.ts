import {
  groupbuyAdminActivityCreate,
  groupbuyAdminActivityList,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../src/server';

/**
 * `/admin-api/groupbuy-activities` — the campaign list and the create form.
 *
 * The segment is `groupbuy-activities` rather than `combination`: that word is
 * a transliteration of nothing and the URL is what an operator's browser
 * history shows.
 */
export const GET = handle(groupbuyAdminActivityList, (ctx, { query }) =>
  groupbuy.adminActivityList(ctx, query),
);

export const POST = handle(groupbuyAdminActivityCreate, async (ctx, { body }) => {
  const created = await groupbuy.adminActivityCreate(ctx, body);
  ctx.audit(`groupbuy-activity:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
