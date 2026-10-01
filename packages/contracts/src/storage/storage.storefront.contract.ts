import { defineRoute } from '../_conventions/route';
import {
  attachmentItemExample,
  scanTokenParams,
  uploadResult,
  userUploadQuery,
  userUploadResult,
  userUploadResultExample,
} from './schemas';

/**
 * Uploads that do not come from the admin console.
 *
 * Two of them, and they are deliberately different:
 *
 * - `/api/v1/uploads` is the shopper's: avatar, review pictures, refund
 *   evidence. It needs a storefront session, is rate-limited per user, accepts
 *   images only, and answers with a renderable URL rather than a library row.
 * - `/api/v1/attachments/scan-uploads/:token` is the phone that scanned an
 *   admin's QR code. It is `public` because the phone has no admin cookie — the
 *   single-use token *is* the credential, and it carries the admin's identity,
 *   so the attachment lands in the right library owned by the right person.
 */

/**
 * `multipart/form-data` with **exactly one** part named `file`.
 *
 * The field name is part of the contract, not a convention: an upload has no
 * JSON body for `handle()` to validate, so nothing else can catch the client
 * that sends `image` or `multipart`. A file under any other name is
 * `STORAGE_UPLOAD_FIELD_MISSING`, which names the fix, rather than
 * `STORAGE_NO_FILE`, which would tell the shopper to pick a photo they had
 * already picked.
 *
 * Further file parts in the same request are **ignored**, not refused: the one
 * named `file` is the upload, and a form that also carries, say, a thumbnail
 * the server does not want should not fail outright.
 */
export const storageUserUpload = defineRoute({
  id: 'storage.userUpload',
  method: 'POST',
  path: '/api/v1/uploads',
  auth: 'user',
  summary: '上传图片（头像/评价/退款凭证/商家素材）',
  tags: ['storage'],
  query: userUploadQuery,
  response: userUploadResult,
  status: 201,
  errors: [
    'STORAGE_NO_FILE',
    'STORAGE_UPLOAD_FIELD_MISSING',
    'FORBIDDEN',
    'STORAGE_FILE_TOO_LARGE',
    'STORAGE_FILE_TYPE_REJECTED',
    'STORAGE_MIME_MISMATCH',
    'STORAGE_UPLOAD_RATE_LIMITED',
    'STORAGE_WRITE_FAILED',
  ],
  examples: [
    { name: 'review-photo', query: { purpose: 'review' }, response: userUploadResultExample },
    {
      name: 'avatar',
      query: { purpose: 'avatar' },
      response: {
        ...userUploadResultExample,
        url: '/uploads/avatar/2026/09/1b2c3d4e5f60718293a4b5c6d7e8f901.png',
        name: '1b2c3d4e5f60718293a4b5c6d7e8f901.png',
        mime: 'image/png',
        size: 20481,
        width: 256,
        height: 256,
      },
    },
  ],
});

export const storageScanUpload = defineRoute({
  id: 'storage.scanUpload',
  method: 'POST',
  path: '/api/v1/attachments/scan-uploads/:token',
  auth: 'public',
  summary: '扫码上传素材',
  tags: ['storage'],
  params: scanTokenParams,
  response: uploadResult,
  status: 201,
  errors: [
    'STORAGE_UPLOAD_RATE_LIMITED',
    'STORAGE_SCAN_TOKEN_INVALID',
    'STORAGE_NO_FILE',
    'STORAGE_UPLOAD_FIELD_MISSING',
    'STORAGE_FILE_TOO_LARGE',
    'STORAGE_FILE_TYPE_REJECTED',
    'STORAGE_MIME_MISMATCH',
    'STORAGE_WRITE_FAILED',
  ],
  examples: [
    {
      name: 'from-the-phone',
      params: { token: 'sJ9vQx2mR7pL4nT8wK1cF6hB3dZ5aY0e' },
      response: { attachment: attachmentItemExample, deduped: false },
    },
  ],
});
