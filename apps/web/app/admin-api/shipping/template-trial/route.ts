import { shippingTemplateTrial } from '@shop/contracts/shipping/shipping.template.admin.contract';
import { freightTrial } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/** `POST /admin-api/shipping/template-trial` — 运费试算. Reads only; nothing to audit. */
export const POST = handle(shippingTemplateTrial, (ctx, { body }) => freightTrial(ctx, body));

export const dynamic = 'force-dynamic';
