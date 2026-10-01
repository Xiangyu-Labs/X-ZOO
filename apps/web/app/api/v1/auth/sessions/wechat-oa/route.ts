import { authOaLogin } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';
import { requestMeta } from '../../_request';

/** `POST /api/v1/auth/sessions/wechat-oa` — the `code` from the OAuth redirect. */
export const POST = handle(authOaLogin, (ctx, { body }) =>
  user.oaLogin(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
