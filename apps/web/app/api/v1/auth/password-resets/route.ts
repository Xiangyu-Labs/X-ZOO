import { authResetPassword } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `POST /api/v1/auth/password-resets` — forgotten password, proved by an SMS code. */
export const POST = handle(authResetPassword, (ctx, { body }) => user.resetPassword(ctx, body));

export const dynamic = 'force-dynamic';
