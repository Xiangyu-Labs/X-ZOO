import type {
  AdminArticleDetail,
  AdminArticleListItem,
  AdminArticleListQuery,
  ArticleDetail,
  ArticleForm,
  ArticleListItem,
  ArticleListQuery,
  ArticleProduct,
  ArticleStatus,
} from '@shop/contracts/cms/schemas';
import type { Tx } from '@shop/db';
import { productCardsFor } from '../catalog';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { sanitizeHtml } from './cms.sanitize';
import * as repo from './cms.repo';

/**
 * 文章.
 *
 * Three rules, each one a line of code:
 *
 *  1. **Drafts are private.** A list that filtered on neither status nor
 *     visibility would make an article live the moment it was saved, and a
 *     detail route that served any id would leak the rest. Every storefront
 *     read here goes through `status: 'published'`, and the one refusal the
 *     public gets is `CMS_ARTICLE_NOT_FOUND` — saying "this exists but is a
 *     draft" would hand back what the filter just took away.
 *  2. **HTML is never stored raw.** `sanitizeHtml` runs on write, so the column
 *     holds safe markup and no read path can reintroduce the hole.
 *  3. **The view counter is one statement**, not a read-modify-write:
 *     `UPDATE … SET views = views + 1 RETURNING views`.
 *
 * The related product is read through the catalog's own `productCardsFor`, so
 * an article pointing at an unpublished or deleted product renders with
 * `product: null` instead of advertising something nobody can buy.
 */

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export async function list(
  ctx: Ctx,
  query: AdminArticleListQuery,
): Promise<{ items: AdminArticleListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listArticles(ctx.db, {
    keyword: query.keyword,
    categoryId: query.categoryId === undefined ? undefined : fromId(query.categoryId),
    status: query.status,
    isHot: query.isHot,
    isBanner: query.isBanner,
    sortBy: query.sortBy as repo.ArticleSortKey | undefined,
    sortOrder: query.sortOrder,
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return {
    items: rows.map(toAdminRow),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function detail(ctx: Ctx, params: { id: string }): Promise<AdminArticleDetail> {
  const row = await repo.findArticle(ctx.db, fromId(params.id));
  if (row === null) throw new DomainError('CMS_ARTICLE_NOT_FOUND');
  return { ...toAdminRow(row), contentHtml: row.contentHtml, product: await product(ctx, row) };
}

export async function create(ctx: Ctx, body: ArticleForm): Promise<AdminArticleDetail> {
  await assertCategory(ctx, body.categoryId);
  const id = await ctx.withTx(async (tx) => {
    const row = await insertOrFail(tx, ctx, body);
    await repo.upsertContent(tx, row.id, sanitizeHtml(body.contentHtml));
    return row.id;
  });
  return detail(ctx, { id: toId(id) });
}

export async function update(
  ctx: Ctx,
  params: { id: string },
  body: ArticleForm,
): Promise<AdminArticleDetail> {
  const id = fromId(params.id);
  const existing = await repo.findArticle(ctx.db, id);
  if (existing === null) throw new DomainError('CMS_ARTICLE_NOT_FOUND');
  await assertCategory(ctx, body.categoryId);

  await ctx.withTx(async (tx) => {
    try {
      const row = await repo.updateArticle(tx, id, {
        ...values(body),
        publishedAt: publishedAt(body.status, existing.publishedAt, ctx),
      });
      if (row === null) throw new DomainError('CMS_ARTICLE_NOT_FOUND');
    } catch (error) {
      if (repo.isDuplicateSlug(error)) {
        throw new DomainError('CMS_ARTICLE_SLUG_TAKEN', { details: { slug: body.slug } });
      }
      throw error;
    }
    await repo.upsertContent(tx, id, sanitizeHtml(body.contentHtml));
  });
  return detail(ctx, params);
}

/**
 * 发布 / 隐藏, the one button the list row carries.
 *
 * Publishing stamps `publishedAt` the first time and never again, so
 * un-hiding an article does not re-date it to the top of the storefront list.
 */
export async function setStatus(
  ctx: Ctx,
  params: { id: string },
  body: { status: ArticleStatus },
): Promise<AdminArticleDetail> {
  const id = fromId(params.id);
  const existing = await repo.findArticle(ctx.db, id);
  if (existing === null) throw new DomainError('CMS_ARTICLE_NOT_FOUND');

  const row = await repo.updateArticle(ctx.db, id, {
    status: body.status,
    publishedAt: publishedAt(body.status, existing.publishedAt, ctx),
  });
  if (row === null) throw new DomainError('CMS_ARTICLE_NOT_FOUND');
  return detail(ctx, params);
}

/**
 * Soft delete, and it releases the slug.
 *
 * `articles_slug_uq` covers the whole table, deleted rows included, so a
 * deleted article would otherwise keep squatting on `/article/double-eleven`
 * forever — with nothing in the admin able to show the operator what is holding
 * it. The row survives for the audit trail; its URL does not.
 */
export async function remove(ctx: Ctx, params: { id: string }): Promise<{ deleted: true }> {
  const affected = await repo.softDeleteArticle(ctx.db, fromId(params.id), ctx.clock.now());
  if (affected === 0) throw new DomainError('CMS_ARTICLE_NOT_FOUND');
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

export async function publicList(
  ctx: Ctx,
  query: ArticleListQuery,
): Promise<{ items: ArticleListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listArticles(ctx.db, {
    status: 'published',
    keyword: query.keyword,
    categoryId: query.categoryId === undefined ? undefined : fromId(query.categoryId),
    categoryIds: query.categoryIds?.map(fromId),
    ids: query.ids?.map(fromId),
    ...(query.feature === 'hot' ? { isHot: true } : {}),
    ...(query.feature === 'banner' ? { isBanner: true } : {}),
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return { items: rows.map(toPublicRow), total, page: query.page, pageSize: query.pageSize };
}

/**
 * Reading an article counts as a read.
 *
 * The increment runs before the row is shaped, and the response carries the
 * number it produced — a reader who refreshes sees their own view. It is
 * deliberately not deduplicated by session: it counts reads, and a counter that
 * quietly changed meaning would make every earlier figure a lie.
 */
export async function publicDetail(ctx: Ctx, params: { id: string }): Promise<ArticleDetail> {
  const id = fromId(params.id);
  const row = await repo.findArticle(ctx.db, id, { status: 'published' });
  if (row === null) throw new DomainError('CMS_ARTICLE_NOT_FOUND');
  const views = await repo.bumpViews(ctx.db, id);
  return {
    ...toPublicRow(row),
    views: views ?? row.views,
    contentHtml: row.contentHtml,
    product: await product(ctx, row),
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function insertOrFail(tx: Tx, ctx: Ctx, body: ArticleForm): Promise<repo.ArticleRow> {
  try {
    return await repo.insertArticle(tx, {
      ...values(body),
      publishedAt: publishedAt(body.status, null, ctx),
    });
  } catch (error) {
    if (repo.isDuplicateSlug(error)) {
      throw new DomainError('CMS_ARTICLE_SLUG_TAKEN', { details: { slug: body.slug } });
    }
    throw error;
  }
}

function values(body: ArticleForm): Omit<repo.NewArticleValues, 'publishedAt'> {
  return {
    categoryId: body.categoryId === null ? null : fromId(body.categoryId),
    title: body.title,
    slug: body.slug,
    author: body.author,
    coverImageUrl: body.coverImageUrl,
    summary: body.summary,
    shareTitle: body.shareTitle,
    shareSummary: body.shareSummary,
    sourceUrl: body.sourceUrl,
    productId: body.productId === null ? null : fromId(body.productId),
    status: body.status,
    isHot: body.isHot,
    isBanner: body.isBanner,
    sortOrder: body.sortOrder,
  };
}

/** `articles_published_shape` requires a timestamp on a published row. */
function publishedAt(status: ArticleStatus, current: Date | null, ctx: Ctx): Date | null {
  if (status !== 'published') return current;
  return current ?? ctx.clock.now();
}

async function assertCategory(ctx: Ctx, categoryId: string | null): Promise<void> {
  if (categoryId === null) return;
  const category = await repo.findCategory(ctx.db, fromId(categoryId));
  if (category === null) throw new DomainError('CMS_CATEGORY_NOT_FOUND');
}

async function product(ctx: Ctx, row: repo.ArticleRow): Promise<ArticleProduct | null> {
  if (row.productId === null) return null;
  const [card] = await productCardsFor(ctx, [row.productId]);
  if (card === undefined) return null;
  return {
    id: card.id,
    name: card.name,
    imageUrl: card.imageUrl,
    price: card.price,
    originalPrice: card.originalPrice,
  };
}

function toPublicRow(row: repo.ArticleListRow): ArticleListItem {
  return {
    id: toId(row.id),
    categoryId: row.categoryId === null ? null : toId(row.categoryId),
    categoryTitle: row.categoryTitle,
    title: row.title,
    slug: row.slug,
    author: row.author,
    coverImageUrl: row.coverImageUrl,
    summary: row.summary,
    sourceUrl: row.sourceUrl,
    isHot: row.isHot,
    isBanner: row.isBanner,
    views: row.views,
    sortOrder: row.sortOrder,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
  };
}

function toAdminRow(row: repo.ArticleListRow): AdminArticleListItem {
  return {
    ...toPublicRow(row),
    status: row.status,
    productId: row.productId === null ? null : toId(row.productId),
    shareTitle: row.shareTitle,
    shareSummary: row.shareSummary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
