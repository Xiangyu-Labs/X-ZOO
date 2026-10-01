import { userAddressSetDefault } from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';

/** `POST /api/v1/addresses/:id/default` — promote one; a partial unique index keeps it single. */
export const POST = handle(userAddressSetDefault, (ctx, { params }) =>
  user.addressSetDefault(ctx, params),
);

export const dynamic = 'force-dynamic';
