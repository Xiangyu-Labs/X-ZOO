import { storageAttachmentDeleteMany } from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/attachments/deletions` — batch delete.
 *
 * A POST with a body rather than `DELETE ?ids=1,2,3`, because two hundred ids
 * do not belong in a URL and a query string is logged by every proxy on the
 * way. The delete is soft: a description written years ago may still point at
 * the file, so the row is tombstoned and the sweeper removes the bytes later.
 */
export const POST = handle(storageAttachmentDeleteMany, async (ctx, { body }) => {
  const result = await storage.attachmentDeleteMany(ctx, body);
  ctx.audit(`attachment:${body.ids.join(',')}`);
  return result;
});

export const dynamic = 'force-dynamic';
