import {
  shippingTemplateCreate,
  shippingTemplateList,
} from '@shop/contracts/shipping/shipping.template.admin.contract';
import { templates } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/** `/admin-api/shipping/templates` — the 运费模板 list and the create form. */
export const GET = handle(shippingTemplateList, (ctx, { query }) => templates.list(ctx, query));

export const POST = handle(shippingTemplateCreate, async (ctx, { body }) => {
  const created = await templates.create(ctx, body);
  ctx.audit(`shipping-template:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
