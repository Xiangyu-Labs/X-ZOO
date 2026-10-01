import { systemAgreementGet } from '@shop/contracts/system/system.settings.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/agreements/:key` — 用户协议 / 隐私政策 / 注销协议.
 *
 * Public, because a shopper has to be able to read the terms *before*
 * registering. The text is a config group, not a fourth CRUD screen with its
 * own table: it is three fields an operator edits twice a year.
 */
export const GET = handle(systemAgreementGet, (ctx, { params }) =>
  system.agreementGet(ctx, params),
);

export const dynamic = 'force-dynamic';
