import { invoiceTitleSetDefault } from '@shop/contracts/user/user.invoice-title.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';

/** `POST /api/v1/invoice-titles/:id/default` — promote one; the others lose the flag. */
export const POST = handle(invoiceTitleSetDefault, (ctx, { params }) =>
  user.invoiceTitleSetDefault(ctx, params),
);

export const dynamic = 'force-dynamic';
