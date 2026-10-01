import {
  userCurrentCancellation,
  userWithdrawCancellation,
} from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** The caller's open request: read it, or take it back before it is reviewed. */
export const GET = handle(userCurrentCancellation, (ctx) => user.currentCancellation(ctx));

export const DELETE = handle(userWithdrawCancellation, (ctx) => user.withdrawCancellation(ctx));

export const dynamic = 'force-dynamic';
