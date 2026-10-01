import { authSmsLogin } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';
import { requestMeta } from '../../_request';

/** `POST /api/v1/auth/sessions/sms` — code login, which registers a new number. */
export const POST = handle(authSmsLogin, (ctx, { body }) =>
  user.smsLogin(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
