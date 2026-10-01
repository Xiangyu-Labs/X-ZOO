import { storageAttachmentImport } from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/attachments/imports` — 从网址导入, the `onlineUpload` successor.
 *
 * The URL goes through `safeFetch`, which resolves DNS itself, refuses every
 * private, loopback, link-local, multicast and cloud-metadata address *after*
 * resolution, connects by IP with the original `Host`, and re-runs all of it on
 * each redirect. The old endpoint called `file_get_contents($url)`.
 */
export const POST = handle(storageAttachmentImport, async (ctx, { body }) => {
  const result = await storage.attachmentImport(ctx, body);
  ctx.audit(`attachment:${result.attachment.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
