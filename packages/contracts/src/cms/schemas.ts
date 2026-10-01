import { z } from 'zod';
import { id, idList, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Articles and article categories.
 *
 * Three things here are deliberate:
 *
 * 1. **`status` is an enum, and the storefront only ever sees `published`**, so
 *    a draft is not public the moment it is saved.
 * 2. **`contentHtml` is sanitised on write**, so whatever the editor produced,
 *    including `<script>`, is never stored or served verbatim. Escaping on save
 *    and unescaping on read would net exactly zero.
 * 3. **`views` is a number, not text.** It is incremented by one atomic
 *    `UPDATE … SET views = views + 1`, not read-modify-written.
 */

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/** Mirrors the `article_categories_status` PostgreSQL enum. */
export const articleCategoryStatus = z.enum(['visible', 'hidden']);
export type ArticleCategoryStatus = z.infer<typeof articleCategoryStatus>;

export const articleCategory = z.object({
  id,
  parentId: id.nullable(),
  title: z.string(),
  intro: z.string().nullable(),
  imageUrl: z.string().nullable(),
  status: articleCategoryStatus,
  sortOrder: z.number().int(),
  /** 0 for a top-level category, 1 for a child. The tree is capped at two levels. */
  depth: z.number().int().min(0).max(1),
  /** Published articles filed directly under this category. */
  articleCount: z.number().int().min(0),
  createdAt: instant,
});
export type ArticleCategory = z.infer<typeof articleCategory>;

/**
 * The tree arrives flat, depth-first, and the client nests it — the same
 * decision as the attachment tree, for the same two reasons: a `z.lazy`
 * self-reference overflows `zod-to-openapi`, and `CrudTable` wants a flat list.
 */
export const articleCategoryList = z.object({ items: z.array(articleCategory) });
export type ArticleCategoryList = z.infer<typeof articleCategoryList>;

export const articleCategoryForm = z.object({
  title: z.string().trim().min(1).max(100),
  /** `null` = a top-level category. A category whose own parent is set cannot be a parent. */
  parentId: id.nullable().default(null),
  intro: z.string().trim().max(255).nullable().default(null),
  imageUrl: z.string().max(512).nullable().default(null),
  status: articleCategoryStatus.default('visible'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type ArticleCategoryForm = z.infer<typeof articleCategoryForm>;

export const articleCategoryStatusBody = z.object({ status: articleCategoryStatus });

export const articleCategoryListQuery = z.object({
  keyword: z.string().trim().min(1).max(100).optional(),
  status: articleCategoryStatus.optional(),
});
export type ArticleCategoryListQuery = z.infer<typeof articleCategoryListQuery>;

export const articleCategoryExample: ArticleCategory = {
  id: '3',
  parentId: null,
  title: '新闻资讯',
  intro: '商城公告与行业动态',
  imageUrl: '/uploads/2026/01/news.png',
  status: 'visible',
  sortOrder: 10,
  depth: 0,
  articleCount: 12,
  createdAt: '2026-01-01T09:00:00+08:00',
};

export const articleCategoryChildExample: ArticleCategory = {
  id: '4',
  parentId: '3',
  title: '商城公告',
  intro: null,
  imageUrl: null,
  status: 'visible',
  sortOrder: 20,
  depth: 1,
  articleCount: 5,
  createdAt: '2026-01-02T09:00:00+08:00',
};

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

/** Mirrors the `articles_status` PostgreSQL enum. */
export const articleStatus = z.enum(['draft', 'published', 'hidden']);
export type ArticleStatus = z.infer<typeof articleStatus>;

/** The product an article promotes, as the storefront card renders it. */
export const articleProduct = z.object({
  id,
  name: z.string(),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
});
export type ArticleProduct = z.infer<typeof articleProduct>;

const articleCore = z.object({
  id,
  categoryId: id.nullable(),
  categoryTitle: z.string().nullable(),
  title: z.string(),
  slug: z.string().nullable(),
  author: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  summary: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  isHot: z.boolean(),
  isBanner: z.boolean(),
  views: z.number().int().min(0),
  sortOrder: z.number().int(),
  publishedAt: instant.nullable(),
});

export const adminArticleListItem = articleCore.extend({
  status: articleStatus,
  productId: id.nullable(),
  shareTitle: z.string().nullable(),
  shareSummary: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
});
export type AdminArticleListItem = z.infer<typeof adminArticleListItem>;

export const adminArticleDetail = adminArticleListItem.extend({
  /** Sanitised HTML, exactly as stored. */
  contentHtml: z.string(),
  product: articleProduct.nullable(),
});
export type AdminArticleDetail = z.infer<typeof adminArticleDetail>;

export const articleForm = z.object({
  title: z.string().trim().min(1).max(255),
  categoryId: id.nullable().default(null),
  /**
   * Stable URL segment. Optional because the numeric id always works; unique
   * when present.
   */
  slug: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9][a-z0-9-]*$/, '别名只能包含小写字母、数字和连字符')
    .nullable()
    .default(null),
  author: z.string().trim().max(64).nullable().default(null),
  coverImageUrl: z.string().max(512).nullable().default(null),
  summary: z.string().trim().max(255).nullable().default(null),
  shareTitle: z.string().trim().max(255).nullable().default(null),
  shareSummary: z.string().trim().max(255).nullable().default(null),
  /** An article that merely links out; the storefront opens this instead of the body. */
  sourceUrl: z.string().max(512).nullable().default(null),
  productId: id.nullable().default(null),
  /**
   * Rich text. The server strips everything outside its allow-list before
   * storing, so what comes back from the detail route may be shorter than what
   * was sent — that is the sanitiser working, not data loss.
   */
  contentHtml: z.string().max(200_000).default(''),
  status: articleStatus.default('draft'),
  isHot: z.boolean().default(false),
  isBanner: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type ArticleForm = z.infer<typeof articleForm>;

export const articleStatusBody = z.object({ status: articleStatus });

export const adminArticleListQuery = pageQuery
  .extend({
    keyword: z.string().trim().min(1).max(100).optional(),
    categoryId: id.optional(),
    status: articleStatus.optional(),
    isHot: z.stringbool().optional(),
    isBanner: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'views', 'publishedAt', 'createdAt']).shape);
export type AdminArticleListQuery = z.infer<typeof adminArticleListQuery>;

export const pagedAdminArticles = paged(adminArticleListItem);

// --- storefront ------------------------------------------------------------

export const articleListItem = articleCore;
export type ArticleListItem = z.infer<typeof articleListItem>;

export const articleDetail = articleCore.extend({
  contentHtml: z.string(),
  product: articleProduct.nullable(),
});
export type ArticleDetail = z.infer<typeof articleDetail>;

export const articleListQuery = pageQuery.extend({
  categoryId: id.optional(),
  /** Articles filed under any of these categories — a DIY component's 筛选数据. */
  categoryIds: idList.optional(),
  /**
   * Exactly these articles, in this order — what a DIY component's 指定数据
   * saved. An id that is not published (a draft, hidden, or deleted) is
   * skipped, not an error: the page was built before the article went away.
   */
  ids: idList.optional(),
  /**
   * `hot` and `banner` narrow the list to the 热门 and banner articles.
   * Ordering is the same in all three cases — `sortOrder DESC, id DESC`.
   */
  feature: z.enum(['hot', 'banner']).optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
});
export type ArticleListQuery = z.infer<typeof articleListQuery>;

export const pagedArticles = paged(articleListItem);

export const publicArticleCategory = z.object({
  id,
  title: z.string(),
  imageUrl: z.string().nullable(),
  children: z.array(z.object({ id, title: z.string(), imageUrl: z.string().nullable() })),
});
export const publicArticleCategoryList = z.object({ items: z.array(publicArticleCategory) });
export type PublicArticleCategoryList = z.infer<typeof publicArticleCategoryList>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

const articleCoreExample = {
  id: '101',
  categoryId: '3',
  categoryTitle: '新闻资讯',
  title: '双十一活动说明',
  slug: 'double-eleven-2026',
  author: '运营部',
  coverImageUrl: '/uploads/2026/10/cover.png',
  summary: '活动时间、优惠券发放与常见问题。',
  sourceUrl: null,
  isHot: true,
  isBanner: false,
  views: 3421,
  sortOrder: 50,
  publishedAt: '2026-10-20T10:00:00+08:00',
} satisfies z.infer<typeof articleCore>;

export const articleProductExample: ArticleProduct = {
  id: '77',
  name: '云南小粒咖啡豆 500g',
  imageUrl: '/uploads/2026/01/coffee.png',
  price: '69.00',
  originalPrice: '99.00',
};

export const articleListItemExample: ArticleListItem = articleCoreExample;

export const articleDetailExample: ArticleDetail = {
  ...articleCoreExample,
  views: 3422,
  contentHtml: '<p>活动时间：11 月 1 日至 11 月 11 日。</p><p>全场满 199 减 20。</p>',
  product: articleProductExample,
};

export const adminArticleExample: AdminArticleListItem = {
  ...articleCoreExample,
  status: 'published',
  productId: '77',
  shareTitle: '双十一来了',
  shareSummary: '满 199 减 20',
  createdAt: '2026-10-18T14:00:00+08:00',
  updatedAt: '2026-10-20T10:00:00+08:00',
};

export const adminArticleDetailExample: AdminArticleDetail = {
  ...adminArticleExample,
  contentHtml: '<p>活动时间：11 月 1 日至 11 月 11 日。</p><p>全场满 199 减 20。</p>',
  product: articleProductExample,
};
