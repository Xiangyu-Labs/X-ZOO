import { userDefaultAddress } from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/**
 * `GET /api/v1/addresses/default` — what checkout prefills with.
 *
 * `null` rather than a 404 when there is none: a first-time shopper has no
 * default and that is not an error the checkout screen should have to handle.
 */
export const GET = handle(userDefaultAddress, (ctx) => user.defaultAddress(ctx));

export const dynamic = 'force-dynamic';
