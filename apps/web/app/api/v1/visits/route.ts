import { userRecordVisit } from '@shop/contracts/user/user.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';
import { requestMeta } from '../auth/_request';

/**
 * `POST /api/v1/visits` — the page-view beacon behind 访客数 / 浏览量.
 *
 * `user-optional`: most storefront traffic has no session, and a beacon that
 * needed one would count only the visitors who had already signed in — which
 * is precisely the population 访客数 is not about.
 */
export const POST = handle(userRecordVisit, (ctx, { body }) =>
  user.recordVisit(ctx, body, requestMeta(ctx.request)),
);

export const dynamic = 'force-dynamic';
