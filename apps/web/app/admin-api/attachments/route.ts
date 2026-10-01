import {
  storageAttachmentList,
  storageAttachmentUpload,
} from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../src/server';

/**
 * `/admin-api/attachments` — browse the library, and upload into it.
 *
 * The upload is `multipart/form-data`, so the contract declares no `body` and
 * carries its options in the query string: `handle()` parses JSON bodies and
 * nothing else. The file part is read here and the bytes go straight to the
 * service, which decides the type from the bytes themselves.
 */
export const GET = handle(storageAttachmentList, (ctx, { query }) =>
  storage.attachmentList(ctx, query),
);

export const POST = handle(storageAttachmentUpload, async (ctx, { query }) => {
  // A reader, so a body over the ceiling is refused before it is buffered.
  const result = await storage.attachmentUpload(ctx, query, (maxBytes) =>
    storage.readFilePart(ctx.request, { maxBytes }),
  );
  ctx.audit(`attachment:${result.attachment.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
