import { cityTreePublic } from '@shop/contracts/shipping/shipping.city.contract';
import { cityTree } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/cities` — 省市区 for the address form.
 *
 * Immutable seed data: the response carries a `version` fingerprint that is
 * also served as a weak ETag, so there is no cache to clear and no route that
 * clears it.
 */
export const GET = handle(cityTreePublic, (ctx) => cityTree(ctx));

export const dynamic = 'force-dynamic';
