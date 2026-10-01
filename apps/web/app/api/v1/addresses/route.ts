import { userAddressCreate, userAddressList } from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/** `/api/v1/addresses` — the caller's own address book. */
export const GET = handle(userAddressList, (ctx, { query }) => user.addressList(ctx, query));

export const POST = handle(userAddressCreate, (ctx, { body }) => user.addressCreate(ctx, body));

export const dynamic = 'force-dynamic';
