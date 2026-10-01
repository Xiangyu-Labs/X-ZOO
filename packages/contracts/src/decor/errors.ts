import { defineErrors } from '../_conventions/errors';

/** Page decoration v2 (`decor`). */
export const decorErrors = defineErrors({
  DECOR_DOCUMENT_NOT_FOUND: { status: 404, message: '页面不存在' },
  DECOR_REVISION_NOT_FOUND: { status: 404, message: '该发布版本不存在' },
  /**
   * The draft changed since the editor loaded it (another operator, another
   * tab). Nothing was written; reload and redo. `details.version` is the
   * current token.
   */
  DECOR_VERSION_CONFLICT: { status: 409, message: '页面已被其他人修改，请刷新后重新保存' },
  /**
   * The document does not check. On save: the envelope (frame, block ids, size)
   * is broken, nothing was written. On publish / rollback: some content issue
   * remains. `details.issues` lists `{ path, message }`.
   */
  DECOR_DOCUMENT_INVALID: { status: 422, message: '页面内容有误，请按提示修改' },
  /** Publishing a draft that is already the published revision. */
  DECOR_NOTHING_TO_PUBLISH: { status: 409, message: '没有需要发布的修改' },
  /** Designating a document of another kind (a 微页面 as 首页). */
  DECOR_KIND_MISMATCH: { status: 409, message: '页面类型与用途不符' },
  /** Designating a document that was never published: the storefront would have nothing to serve. */
  DECOR_NOT_PUBLISHED: { status: 409, message: '请先发布页面再设为使用中' },
  /** Deleting the current 首页 / 个人中心. */
  DECOR_DOCUMENT_IN_USE: { status: 409, message: '页面正在使用中，请先更换后再删除' },
  /** The storefront asked for the home page and none is designated. */
  DECOR_HOME_NOT_SET: { status: 404, message: '商城首页尚未设置' },
  /** Missing, expired, or issued for another document. */
  DECOR_PREVIEW_TOKEN_INVALID: { status: 403, message: '预览链接已失效，请重新生成' },
});

export type DecorErrorCode = keyof typeof decorErrors;
