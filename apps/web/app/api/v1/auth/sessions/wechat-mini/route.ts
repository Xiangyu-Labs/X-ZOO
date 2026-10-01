import { authMiniLogin } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';
import { requestMeta } from '../../_request';

/** `POST /api/v1/auth/sessions/wechat-mini` — `wx.login()`'s code. */
export const POST = handle(authMiniLogin, (ctx, { body }) =>
  user.miniLogin(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
