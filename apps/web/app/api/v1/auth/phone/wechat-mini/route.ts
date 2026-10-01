import { authBindPhoneWechatMini } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';

/**
 * `POST /api/v1/auth/phone/wechat-mini` — 微信授权手机号 for a signed-in account.
 *
 * The sibling of `POST /api/v1/auth/phone`, which wants an SMS code. Here the
 * number never appears in the request: only WeChat's single-use `phoneCode`
 * does, and the number comes back over a server-to-server call.
 */
export const POST = handle(authBindPhoneWechatMini, (ctx, { body }) =>
  user.bindPhoneFromMini(ctx, body),
);

export const dynamic = 'force-dynamic';
