import { storageAttachmentMoveMany } from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/** `/admin-api/attachments/moves` — batch re-file into another folder. */
export const POST = handle(storageAttachmentMoveMany, async (ctx, { body }) => {
  const result = await storage.attachmentMoveMany(ctx, body);
  ctx.audit(`attachment:${body.ids.join(',')}`);
  return result;
});

export const dynamic = 'force-dynamic';
