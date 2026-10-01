import { userRequestCancellation } from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/**
 * `POST /api/v1/account-cancellations` — file a 注销申请.
 *
 * It does not close the account: an operator reviews it, and until then the
 * account keeps working. Somebody with an unshipped order must not be able to
 * destroy their own evidence with one tap.
 */
export const POST = handle(userRequestCancellation, (ctx, { body }) =>
  user.requestCancellation(ctx, body),
);

export const dynamic = 'force-dynamic';
