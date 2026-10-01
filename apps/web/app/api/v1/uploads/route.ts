import { storageUserUpload } from '@shop/contracts/storage/storage.storefront.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/uploads` — a shopper's avatar, review photo or refund evidence.
 *
 * Images only, a smaller ceiling than the admin's, and a per-user hourly
 * budget: the three things that stop a review form from becoming free hosting.
 * The response carries the URL and nothing about the library.
 */
export const POST = handle(storageUserUpload, (ctx, { query }) =>
  // A reader, not the bytes: the body is read after the hourly budget is spent,
  // and refused unread when it is larger than the shopper ceiling.
  storage.userUpload(ctx, query, (maxBytes) => storage.readFilePart(ctx.request, { maxBytes })),
);

export const dynamic = 'force-dynamic';
