import { authBindPhone, authChangePhone } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `POST` binds a number to an account that has none; `PUT` replaces the one it has. */
export const POST = handle(authBindPhone, (ctx, { body }) => user.bindPhone(ctx, body));

export const PUT = handle(authChangePhone, (ctx, { body }) => user.changePhone(ctx, body));

export const dynamic = 'force-dynamic';
