import {
  catalogAdminLabelCreate,
  catalogAdminLabelList,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/labels` — 商品标签. */

export const GET = handle(catalogAdminLabelList, (ctx, { query }) =>
  catalog.adminLabelList(ctx, query),
);

export const POST = handle(catalogAdminLabelCreate, async (ctx, { body }) => {
  const created = await catalog.adminLabelCreate(ctx, body);
  ctx.audit(`label:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
