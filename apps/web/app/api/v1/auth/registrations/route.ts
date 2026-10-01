import { authRegister } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';
import { requestMeta } from '../_request';

/** `POST /api/v1/auth/registrations` — phone, code and a password. */
export const POST = handle(authRegister, (ctx, { body }) =>
  user.register(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
