import { decorDocumentDuplicate } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../src/server';

export const POST = handle(decorDocumentDuplicate, async (ctx, { params, body }) => {
  const copy = await decor.duplicateDocument(ctx, { ...params, ...body });
  ctx.audit(`decor:document:${copy.id}`);
  return copy;
});

export const dynamic = 'force-dynamic';
