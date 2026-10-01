import { shippingTemplateOptionList } from '@shop/contracts/shipping/shipping.template.admin.contract';
import { templates } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/** `/admin-api/shipping/template-options` — what the product editor's 运费模板 select needs. */
export const GET = handle(shippingTemplateOptionList, (ctx) => templates.options(ctx));

export const dynamic = 'force-dynamic';
