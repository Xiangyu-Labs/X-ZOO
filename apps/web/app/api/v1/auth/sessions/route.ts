import { authLogoutEverywhere } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `DELETE /api/v1/auth/sessions` — 退出所有设备, including this one. */
export const DELETE = handle(authLogoutEverywhere, (ctx) => user.logoutEverywhere(ctx));

export const dynamic = 'force-dynamic';
