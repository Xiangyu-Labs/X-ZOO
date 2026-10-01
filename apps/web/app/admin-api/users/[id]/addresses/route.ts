import { userAdminAddressList } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `GET /admin-api/users/:id/addresses` — what support reads out over the phone. */
export const GET = handle(userAdminAddressList, (ctx, { params }) =>
  user.adminAddressList(ctx, params),
);

export const dynamic = 'force-dynamic';
