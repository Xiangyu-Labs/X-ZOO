import {
  presaleAdminActivityDelete,
  presaleAdminActivityDetail,
  presaleAdminActivityUpdate,
} from '@shop/contracts/presale/presale.admin.contract';
import * as presale from '@shop/core/presale';
import { handle } from '../../../../src/server';

/** `/admin-api/presale-activities/:id` — read, edit, soft-delete one campaign. */
export const GET = handle(presaleAdminActivityDetail, (ctx, { params }) =>
  presale.adminActivityDetail(ctx, params),
);

export const PUT = handle(presaleAdminActivityUpdate, async (ctx, { params, body }) => {
  const updated = await presale.adminActivityUpdate(ctx, params, body);
  ctx.audit(`presale:${params.id}`);
  return updated;
});

export const DELETE = handle(presaleAdminActivityDelete, async (ctx, { params }) => {
  await presale.adminActivityDelete(ctx, params);
  ctx.audit(`presale:${params.id}`);
});

export const dynamic = 'force-dynamic';
