import { invoiceTitleDefault } from '@shop/contracts/user/user.invoice-title.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `GET /api/v1/invoice-titles/default` — the title 申请开票 preselects, or `null`. */
export const GET = handle(invoiceTitleDefault, (ctx) => user.invoiceTitleDefault(ctx));

export const dynamic = 'force-dynamic';
