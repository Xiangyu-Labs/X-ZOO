import { authSendSmsCode } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';
import { requestMeta } from '../_request';

/**
 * `POST /api/v1/auth/sms-codes` — send a verification code.
 *
 * `user-optional`: the `bind-phone` and `change-phone` scenes act on the
 * account the caller is signed in as, and the service refuses them without a
 * session; the rest are how somebody signs in in the first place.
 */
export const POST = handle(authSendSmsCode, (ctx, { body }) =>
  user.sendSmsCode(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
