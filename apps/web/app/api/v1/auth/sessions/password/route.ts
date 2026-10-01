import { authPasswordLogin } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';
import { requestMeta } from '../../_request';

/** `POST /api/v1/auth/sessions/password` — account or phone, plus a password. */
export const POST = handle(authPasswordLogin, (ctx, { body }) =>
  user.passwordLogin(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
