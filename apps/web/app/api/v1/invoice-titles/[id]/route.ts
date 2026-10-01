import {
  invoiceTitleDelete,
  invoiceTitleDetail,
  invoiceTitleUpdate,
} from '@shop/contracts/user/user.invoice-title.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/** `/api/v1/invoice-titles/:id` — one of the caller's own titles; anybody else's is a 404. */
export const GET = handle(invoiceTitleDetail, (ctx, { params }) =>
  user.invoiceTitleDetail(ctx, params),
);

export const PUT = handle(invoiceTitleUpdate, (ctx, { params, body }) =>
  user.invoiceTitleUpdate(ctx, params, body),
);

export const DELETE = handle(invoiceTitleDelete, (ctx, { params }) =>
  user.invoiceTitleDelete(ctx, params),
);

export const dynamic = 'force-dynamic';
