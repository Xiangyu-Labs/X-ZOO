import { defineErrors } from '../_conventions/errors';

/**
 * `storage` error codes.
 *
 * Every upload refusal is a 4xx a user can act on, and each one names the rule
 * it broke rather than "上传失败". The three that matter most: a file whose
 * *bytes* are not what its name and `Content-Type` claim, a remote URL pointing
 * inside the network, and a scan token used twice.
 */
export const storageErrors = defineErrors({
  /** No `file` part in the multipart body, or it was empty. */
  STORAGE_NO_FILE: { status: 422, message: '请选择要上传的文件' },
  /**
   * There *is* a file in the request, under some other field name. Separated
   * from `STORAGE_NO_FILE` because it is a client bug with a one-word fix and
   * no amount of the user retrying will help: `details` carries
   * `{ expected: 'file', received: [...] }` so the log says which name to
   * change. Otherwise a mismatch would look to the shopper exactly like picking
   * no photo at all.
   */
  STORAGE_UPLOAD_FIELD_MISSING: { status: 422, message: '上传字段名不正确，应为 file' },
  /** Over the configured size limit. `details` carries `{ maxBytes, size }`. */
  STORAGE_FILE_TOO_LARGE: { status: 422, message: '文件过大，请压缩后再上传' },
  /**
   * The magic bytes say this is not a type we accept — including an HTML or SVG
   * file dressed as a PNG, and anything executable. `details` carries
   * `{ detected }`.
   */
  STORAGE_FILE_TYPE_REJECTED: { status: 422, message: '不支持的文件类型' },
  /**
   * The bytes are a type we accept, but not the one the request claimed.
   * Refused rather than silently corrected: a mismatch is either a broken
   * client or an attempt. `details` carries `{ declared, detected }`.
   */
  STORAGE_MIME_MISMATCH: { status: 422, message: '文件内容与类型不符' },
  /** The driver refused to store the bytes. The reason is logged, not returned. */
  STORAGE_WRITE_FAILED: { status: 502, message: '文件保存失败，请稍后再试' },

  STORAGE_ATTACHMENT_NOT_FOUND: { status: 404, message: '素材不存在' },
  STORAGE_CATEGORY_NOT_FOUND: { status: 404, message: '素材分类不存在' },
  /** Deleting a category that still holds files or child categories. */
  STORAGE_CATEGORY_NOT_EMPTY: { status: 409, message: '该分类下还有素材或子分类，无法删除' },
  /** Making a category its own ancestor, or nesting deeper than the tree allows. */
  STORAGE_CATEGORY_INVALID_PARENT: { status: 422, message: '上级分类不合法' },

  /**
   * `safe-fetch` refused the URL: a private, loopback, link-local, multicast or
   * cloud-metadata address, a non-http(s) scheme, or a redirect to one. Same
   * message in every case so the endpoint is not a network scanner.
   */
  STORAGE_REMOTE_URL_REFUSED: { status: 422, message: '该地址不允许访问' },
  /** The remote host answered with an error, too slowly, or with too many bytes. */
  STORAGE_REMOTE_FETCH_FAILED: { status: 502, message: '无法下载该地址的文件' },

  /** Unknown, expired, already used, or minted by a different admin. */
  STORAGE_SCAN_TOKEN_INVALID: { status: 404, message: '二维码已失效，请重新生成' },

  /** The storefront per-user upload budget. `details` carries `{ retryAfterMs }`. */
  STORAGE_UPLOAD_RATE_LIMITED: { status: 429, message: '上传过于频繁，请稍后再试' },
});

export type StorageErrorCode = keyof typeof storageErrors;
