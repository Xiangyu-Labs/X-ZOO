import { authMiniPhoneLogin } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../../src/server';
import { requestMeta } from '../../../_request';

/**
 * `POST /api/v1/auth/sessions/wechat-mini/phone` — finish with `getPhoneNumber`.
 *
 * No SMS code: the number comes back from WeChat's own endpoint, which is the
 * proof of ownership an SMS code would otherwise have to establish.
 */
export const POST = handle(authMiniPhoneLogin, (ctx, { body }) =>
  user.miniPhoneLogin(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
