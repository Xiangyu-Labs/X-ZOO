import {
  invoiceTitleCreate,
  invoiceTitleList,
} from '@shop/contracts/user/user.invoice-title.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/** `/api/v1/invoice-titles` — the caller's own 发票抬头 book. */
export const GET = handle(invoiceTitleList, (ctx, { query }) => user.invoiceTitleList(ctx, query));

export const POST = handle(invoiceTitleCreate, (ctx, { body }) =>
  user.invoiceTitleCreate(ctx, body),
);

export const dynamic = 'force-dynamic';
