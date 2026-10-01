import { decorPreviewToken } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../src/server';

/** A short-lived link to the draft; audited, since it shows unpublished work outside the admin. */
export const POST = handle(decorPreviewToken, async (ctx, { params }) => {
  const token = await decor.createPreviewToken(ctx, params);
  ctx.audit(`decor:document:${params.id}`);
  return token;
});

export const dynamic = 'force-dynamic';
