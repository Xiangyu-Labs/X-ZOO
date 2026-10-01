import {
  presaleAdminActivityCreate,
  presaleAdminActivityList,
} from '@shop/contracts/presale/presale.admin.contract';
import * as presale from '@shop/core/presale';
import { handle } from '../../../src/server';

/**
 * `/admin-api/presale-activities` — 预售活动 list and create.
 *
 * The URL segment is `presale-activities`, not `advance`: that word is a
 * transliteration of nothing and the URL is what an operator's browser
 * history shows.
 *
 * A route file does three things and no more: name the contract, call one
 * service function, and (for a write) say what was acted on for the audit log.
 */
export const GET = handle(presaleAdminActivityList, (ctx, { query }) =>
  presale.adminActivityList(ctx, query),
);

export const POST = handle(presaleAdminActivityCreate, async (ctx, { body }) => {
  const created = await presale.adminActivityCreate(ctx, body);
  ctx.audit(`presale:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
