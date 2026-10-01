import {
  userAddressDelete,
  userAddressDetail,
  userAddressUpdate,
} from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/addresses/:id` — one address of the caller's.
 *
 * Every service call is scoped to the session's user id, so asking for
 * somebody else's id is a 404 rather than a leak.
 */
export const GET = handle(userAddressDetail, (ctx, { params }) => user.addressDetail(ctx, params));

export const PUT = handle(userAddressUpdate, (ctx, { params, body }) =>
  user.addressUpdate(ctx, params, body),
);

export const DELETE = handle(userAddressDelete, (ctx, { params }) =>
  user.addressDelete(ctx, params),
);

export const dynamic = 'force-dynamic';
