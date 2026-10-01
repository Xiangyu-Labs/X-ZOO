import { cityTreeAdmin } from '@shop/contracts/shipping/shipping.city.contract';
import { cityTree } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/** `/admin-api/shipping/cities` — the 运费模板 region picker. Same body as the storefront tree. */
export const GET = handle(cityTreeAdmin, (ctx) => cityTree(ctx));

export const dynamic = 'force-dynamic';
