import {
  catalogAdminParamTemplateCreate,
  catalogAdminParamTemplateList,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/param-templates` — 商品参数 templates. */

export const GET = handle(catalogAdminParamTemplateList, (ctx, { query }) =>
  catalog.adminParamTemplateList(ctx, query),
);

export const POST = handle(catalogAdminParamTemplateCreate, async (ctx, { body }) => {
  const created = await catalog.adminParamTemplateCreate(ctx, body);
  ctx.audit(`param-template:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
