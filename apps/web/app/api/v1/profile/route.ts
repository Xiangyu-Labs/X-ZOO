import { userGetProfile, userUpdateProfile } from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/** `/api/v1/profile` — the signed-in shopper's own record. No id in the path. */
export const GET = handle(userGetProfile, (ctx) => user.getProfile(ctx));

export const PUT = handle(userUpdateProfile, (ctx, { body }) => user.updateProfile(ctx, body));

export const dynamic = 'force-dynamic';
