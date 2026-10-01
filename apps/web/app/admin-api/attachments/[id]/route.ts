import { storageAttachmentUpdate } from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/attachments/:id` — rename and re-file.
 *
 * Never the storage key, the URL, the mime or the size: those describe bytes
 * that are already written, and a library whose metadata can disagree with its
 * objects is a library that lies.
 */
export const PUT = handle(storageAttachmentUpdate, async (ctx, { params, body }) => {
  const item = await storage.attachmentUpdate(ctx, params, body);
  ctx.audit(`attachment:${params.id}`);
  return item;
});

export const dynamic = 'force-dynamic';
