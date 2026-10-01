import { authOaPhoneLogin } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../../src/server';
import { requestMeta } from '../../../_request';

/**
 * `POST /api/v1/auth/sessions/wechat-oa/phone` — finish an OA sign-in.
 *
 * The browser can offer no WeChat-verified number, so this one takes an SMS
 * code — minted with `scene: 'login'`, because the caller has no session yet.
 */
export const POST = handle(authOaPhoneLogin, (ctx, { body }) =>
  user.oaPhoneLogin(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
