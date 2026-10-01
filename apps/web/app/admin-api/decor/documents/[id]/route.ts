import {
  decorDocumentDelete,
  decorDocumentGet,
  decorDocumentRename,
} from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../src/server';

/** `/admin-api/decor/documents/:id` — read with its draft, rename, delete. */
export const GET = handle(decorDocumentGet, (ctx, { params }) => decor.getDocument(ctx, params));

export const PATCH = handle(decorDocumentRename, async (ctx, { params, body }) => {
  const renamed = await decor.renameDocument(ctx, { ...params, ...body });
  ctx.audit(`decor:document:${params.id}`);
  return renamed;
});

export const DELETE = handle(decorDocumentDelete, async (ctx, { params }) => {
  await decor.deleteDocument(ctx, params);
  ctx.audit(`decor:document:${params.id}`);
});

export const dynamic = 'force-dynamic';
