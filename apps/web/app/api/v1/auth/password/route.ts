import { authChangePassword } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/**
 * `PUT /api/v1/auth/password` — change it while signed in.
 *
 * Every session dies, this one included: the shopper who has just changed a
 * password they think somebody else knows expects exactly that.
 */
export const PUT = handle(authChangePassword, (ctx, { body }) => user.changePassword(ctx, body));

export const dynamic = 'force-dynamic';
