import type { DbOrTx } from '@shop/db';
import { articleCategories, articleContents, articles } from '@shop/db/schema/cms';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { containsPattern } from '../kernel/like';

/**
 * The only file in the CMS domain that touches Drizzle tables
 * (`docs/conventions.md`, "Import boundaries").
 *
 * Two tables and a body: `articles` carries everything a list row shows,
 * `article_contents` carries the HTML, and the list never joins it. With the
 * body in the same row, every list query would drag 200 KB of rich text per
 * page across the wire.
 */

export type CategoryRow = typeof articleCategories.$inferSelect;
export type ArticleRow = typeof articles.$inferSelect;

/** An article row plus the two things the wire shape needs from elsewhere. */
export interface ArticleListRow extends ArticleRow {
  categoryTitle: string | null;
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

const liveCategory = isNull(articleCategories.deletedAt);

/**
 * The whole tree in sort order, with the number of *published* articles filed
 * directly under each node.
 *
 * Two statements rather than a correlated sub-select: the counts are a single
 * `group by` over an index, and the join-free version is the one a reader can
 * check. The table holds tens of rows, so neither shape is a performance
 * question — the count is what the editor reads before deleting a category.
 */
export async function listCategories(
  db: DbOrTx,
  filter: { keyword?: string | undefined; status?: 'visible' | 'hidden' | undefined },
): Promise<(CategoryRow & { articleCount: number })[]> {
  const where: SQL[] = [liveCategory];
  if (filter.keyword !== undefined) {
    where.push(ilike(articleCategories.title, containsPattern(filter.keyword)));
  }
  if (filter.status !== undefined) where.push(eq(articleCategories.status, filter.status));

  const rows = await db
    .select()
    .from(articleCategories)
    .where(and(...where))
    .orderBy(asc(articleCategories.sortOrder), asc(articleCategories.id));

  const counts = await db
    .select({ categoryId: articles.categoryId, value: count() })
    .from(articles)
    .where(and(liveArticle, eq(articles.status, 'published')))
    .groupBy(articles.categoryId);
  const byCategory = new Map(counts.map((row) => [row.categoryId, row.value]));

  return rows.map((row) => ({ ...row, articleCount: byCategory.get(row.id) ?? 0 }));
}

export async function findCategory(db: DbOrTx, id: number): Promise<CategoryRow | null> {
  const rows = await db
    .select()
    .from(articleCategories)
    .where(and(eq(articleCategories.id, id), liveCategory))
    .limit(1);
  return rows[0] ?? null;
}

export async function categoryArticleCount(db: DbOrTx, id: number): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(articles)
    .where(and(eq(articles.categoryId, id), isNull(articles.deletedAt)));
  return rows[0]?.value ?? 0;
}

export async function categoryChildCount(db: DbOrTx, id: number): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(articleCategories)
    .where(and(eq(articleCategories.parentId, id), liveCategory));
  return rows[0]?.value ?? 0;
}

export type NewCategoryValues = Omit<
  typeof articleCategories.$inferInsert,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export async function insertCategory(
  db: DbOrTx,
  values: NewCategoryValues,
): Promise<CategoryRow & { articleCount: number }> {
  const rows = await db.insert(articleCategories).values(values).returning();
  const row = rows[0];
  if (row === undefined) throw new Error('insertCategory 未返回行');
  return { ...row, articleCount: 0 };
}

export async function updateCategory(
  db: DbOrTx,
  id: number,
  values: Partial<NewCategoryValues>,
): Promise<CategoryRow | null> {
  const rows = await db
    .update(articleCategories)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(articleCategories.id, id), liveCategory))
    .returning();
  return rows[0] ?? null;
}

/** Soft delete: the FK from `articles.category_id` is `restrict`, and history keeps its name. */
export async function softDeleteCategory(db: DbOrTx, id: number, now: Date): Promise<number> {
  const rows = await db
    .update(articleCategories)
    .set({ deletedAt: now })
    .where(and(eq(articleCategories.id, id), liveCategory))
    .returning({ id: articleCategories.id });
  return rows.length;
}

/** The visible two-level tree the storefront renders, ordered as the admin sorted it. */
export async function listVisibleCategories(db: DbOrTx): Promise<CategoryRow[]> {
  return db
    .select()
    .from(articleCategories)
    .where(and(liveCategory, eq(articleCategories.status, 'visible')))
    .orderBy(asc(articleCategories.sortOrder), asc(articleCategories.id));
}

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

const liveArticle = isNull(articles.deletedAt);

export type ArticleSortKey = 'id' | 'sortOrder' | 'views' | 'publishedAt' | 'createdAt';

const ARTICLE_SORT = {
  id: articles.id,
  sortOrder: articles.sortOrder,
  views: articles.views,
  publishedAt: articles.publishedAt,
  createdAt: articles.createdAt,
} as const;

export interface ArticleFilter {
  keyword?: string | undefined;
  categoryId?: number | undefined;
  /** Any of these categories. */
  categoryIds?: readonly number[] | undefined;
  /** Only these articles; the list then comes back in this order. */
  ids?: readonly number[] | undefined;
  /** `published` alone is what the storefront asks for. */
  status?: 'draft' | 'published' | 'hidden' | undefined;
  isHot?: boolean | undefined;
  isBanner?: boolean | undefined;
}

export interface ArticlePage extends ArticleFilter {
  sortBy?: ArticleSortKey | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  offset: number;
  limit: number;
}

function articleWhere(filter: ArticleFilter): SQL[] {
  const where: SQL[] = [liveArticle];
  if (filter.keyword !== undefined) {
    const like = containsPattern(filter.keyword);
    const match = or(ilike(articles.title, like), ilike(articles.summary, like));
    if (match !== undefined) where.push(match);
  }
  if (filter.categoryId !== undefined) where.push(eq(articles.categoryId, filter.categoryId));
  if (filter.categoryIds !== undefined) {
    where.push(inArray(articles.categoryId, [...filter.categoryIds]));
  }
  if (filter.ids !== undefined) where.push(inArray(articles.id, [...filter.ids]));
  if (filter.status !== undefined) where.push(eq(articles.status, filter.status));
  if (filter.isHot !== undefined) where.push(eq(articles.isHot, filter.isHot));
  if (filter.isBanner !== undefined) where.push(eq(articles.isBanner, filter.isBanner));
  return where;
}

export async function listArticles(
  db: DbOrTx,
  query: ArticlePage,
): Promise<{ rows: ArticleListRow[]; total: number }> {
  const where = and(...articleWhere(query));
  const column = ARTICLE_SORT[query.sortBy ?? 'id'];
  // `sortOrder DESC, id DESC` is the admin list order and the storefront's; an
  // explicit `sortBy` replaces the first key only, never the tiebreak.
  // An id list is its own order: the caller picked these, in this sequence.
  const direction = query.sortOrder === 'asc' ? asc : desc;
  const order =
    query.ids !== undefined
      ? [sql`array_position(${sql.param([...query.ids])}::bigint[], ${articles.id})`]
      : query.sortBy === undefined
        ? [desc(articles.sortOrder), desc(articles.id)]
        : [direction(column), desc(articles.id)];

  const rows = await db
    .select({ row: articles, categoryTitle: articleCategories.title })
    .from(articles)
    .leftJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .where(where)
    .orderBy(...order)
    .offset(query.offset)
    .limit(query.limit);

  const totals = await db.select({ value: count() }).from(articles).where(where);
  return {
    rows: rows.map((row) => ({ ...row.row, categoryTitle: row.categoryTitle })),
    total: totals[0]?.value ?? 0,
  };
}

export async function findArticle(
  db: DbOrTx,
  id: number,
  filter: { status?: 'published' | undefined } = {},
): Promise<(ArticleListRow & { contentHtml: string }) | null> {
  const where: SQL[] = [eq(articles.id, id), liveArticle];
  if (filter.status !== undefined) where.push(eq(articles.status, filter.status));
  const rows = await db
    .select({
      row: articles,
      categoryTitle: articleCategories.title,
      contentHtml: articleContents.contentHtml,
    })
    .from(articles)
    .leftJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .leftJoin(articleContents, eq(articleContents.articleId, articles.id))
    .where(and(...where))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { ...row.row, categoryTitle: row.categoryTitle, contentHtml: row.contentHtml ?? '' };
}

export type NewArticleValues = Omit<
  typeof articles.$inferInsert,
  'id' | 'views' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export async function insertArticle(db: DbOrTx, values: NewArticleValues): Promise<ArticleRow> {
  const rows = await db.insert(articles).values(values).returning();
  const row = rows[0];
  if (row === undefined) throw new Error('insertArticle 未返回行');
  return row;
}

export async function updateArticle(
  db: DbOrTx,
  id: number,
  values: Partial<NewArticleValues>,
): Promise<ArticleRow | null> {
  const rows = await db
    .update(articles)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(articles.id, id), liveArticle))
    .returning();
  return rows[0] ?? null;
}

export async function softDeleteArticle(db: DbOrTx, id: number, now: Date): Promise<number> {
  const rows = await db
    .update(articles)
    .set({ deletedAt: now, slug: null })
    .where(and(eq(articles.id, id), liveArticle))
    .returning({ id: articles.id });
  return rows.length;
}

/** The body lives in its own table, written with the article and never listed. */
export async function upsertContent(db: DbOrTx, articleId: number, html: string): Promise<void> {
  await db
    .insert(articleContents)
    .values({ articleId, contentHtml: html })
    .onConflictDoUpdate({
      target: articleContents.articleId,
      set: { contentHtml: html, updatedAt: sql`now()` },
    });
}

/**
 * One atomic increment, and the number it returns is the one this read
 * produced.
 *
 * Reading the counter, adding one and writing it back loses every increment
 * that overlaps another — the busiest articles undercount the most.
 * `UPDATE … SET views = views + 1 RETURNING views` cannot.
 */
export async function bumpViews(db: DbOrTx, id: number): Promise<number | null> {
  const rows = await db
    .update(articles)
    .set({ views: sql`${articles.views} + 1` })
    .where(and(eq(articles.id, id), liveArticle))
    .returning({ views: articles.views });
  return rows[0]?.views ?? null;
}

/** Ids of live articles among these, for the DIY picker resolving a saved page. */
export async function findArticlesByIds(db: DbOrTx, ids: number[]): Promise<ArticleRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(articles)
    .where(and(inArray(articles.id, ids), liveArticle));
}

/**
 * `articles_slug_uq` refused the write.
 *
 * Asked as a caught error rather than a pre-flight `select`, because a
 * pre-flight select races with the article somebody else saves in between; the
 * unique index is the authority. The driver wraps its errors, so the cause
 * chain is walked (same helper shape as `shipping.repo.ts`).
 */
export function isDuplicateSlug(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== null && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === '23505') return candidate.constraint === 'articles_slug_uq';
    if (typeof candidate.cause !== 'object' || candidate.cause === null) return false;
    current = candidate.cause;
  }
  return false;
}
