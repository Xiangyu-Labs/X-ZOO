import {
  shippingTemplateDelete,
  shippingTemplateDetailRoute,
  shippingTemplateUpdate,
} from '@shop/contracts/shipping/shipping.template.admin.contract';
import { templates } from '@shop/core/shipping';
import { handle } from '../../../../../src/server';

export const GET = handle(shippingTemplateDetailRoute, (ctx, { params }) =>
  templates.detail(ctx, params),
);

export const PUT = handle(shippingTemplateUpdate, async (ctx, { params, body }) => {
  const updated = await templates.update(ctx, params, body);
  ctx.audit(`shipping-template:${updated.id}`);
  return updated;
});

export const DELETE = handle(shippingTemplateDelete, async (ctx, { params }) => {
  const result = await templates.remove(ctx, params);
  ctx.audit(`shipping-template:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
