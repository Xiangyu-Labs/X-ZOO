import { defineErrors } from '../_conventions/errors';

/**
 * Article and article-category error codes.
 *
 * The storefront gets exactly one refusal — `CMS_ARTICLE_NOT_FOUND` — and it
 * covers "no such id", "soft-deleted" and "not published". Telling the public
 * *which* of the three it is would confirm that a draft or hidden article
 * exists to anybody guessing ids.
 */
export const cmsErrors = defineErrors({
  CMS_ARTICLE_NOT_FOUND: { status: 404, message: '文章不存在' },
  CMS_CATEGORY_NOT_FOUND: { status: 404, message: '文章分类不存在' },
  /** A category with children, or with articles filed under it. `details` carries `{ children, articles }`. */
  CMS_CATEGORY_NOT_EMPTY: { status: 409, message: '该分类下还有子分类或文章，无法删除' },
  /** The editor caps the tree at two levels, same as the storefront renders. */
  CMS_CATEGORY_TOO_DEEP: { status: 422, message: '文章分类最多两级' },
  /** A category cannot be its own parent, nor a parent of its own ancestor. */
  CMS_CATEGORY_CYCLE: { status: 422, message: '不能把分类移动到它自己的下级' },
  /** `articles_slug_uq` refused the insert. `details` carries `{ slug }`. */
  CMS_ARTICLE_SLUG_TAKEN: { status: 409, message: '该文章别名已被占用' },
});

export type CmsErrorCode = keyof typeof cmsErrors;
