import { decorDocumentCreate, decorDocumentList } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../src/server';

/** `/admin-api/decor/documents` — the page list, and a new page. */
export const GET = handle(decorDocumentList, (ctx, { query }) => decor.listDocuments(ctx, query));

export const POST = handle(decorDocumentCreate, async (ctx, { body }) => {
  const created = await decor.createDocument(ctx, body);
  ctx.audit(`decor:document:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
