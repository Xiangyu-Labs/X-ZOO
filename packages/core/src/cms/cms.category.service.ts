import type {
  ArticleCategory,
  ArticleCategoryForm,
  ArticleCategoryListQuery,
  ArticleCategoryStatus,
  PublicArticleCategoryList,
} from '@shop/contracts/cms/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import * as repo from './cms.repo';

/**
 * 文章分类.
 *
 * Two levels, enforced here rather than by the database, because the storefront
 * renders exactly two (a tab row and its sub-tabs); a third level would be one
 * no screen ever displays. The rules:
 *
 *  - a category whose own parent is set cannot become a parent
 *    (`CMS_CATEGORY_TOO_DEEP`);
 *  - a category that already has children cannot be given a parent (same code —
 *    it would push its children to level 2);
 *  - a category cannot be moved under itself or under one of its own children
 *    (`CMS_CATEGORY_CYCLE`);
 *  - a category with children or with articles is not deleted
 *    (`CMS_CATEGORY_NOT_EMPTY`, with the two counts in `details`).
 *
 * The list arrives flat and depth-first; see the contract for why it is not
 * nested.
 */

export async function list(
  ctx: Ctx,
  query: ArticleCategoryListQuery,
): Promise<{ items: ArticleCategory[] }> {
  const rows = await repo.listCategories(ctx.db, {
    keyword: query.keyword,
    status: query.status,
  });
  return { items: flatten(rows) };
}

export async function create(ctx: Ctx, body: ArticleCategoryForm): Promise<ArticleCategory> {
  const parentId = await resolveParent(ctx, body.parentId, null);
  const row = await repo.insertCategory(ctx.db, {
    parentId,
    title: body.title,
    intro: body.intro,
    imageUrl: body.imageUrl,
    status: body.status,
    sortOrder: body.sortOrder,
  });
  return toWire(row, row.articleCount);
}

export async function update(
  ctx: Ctx,
  params: { id: string },
  body: ArticleCategoryForm,
): Promise<ArticleCategory> {
  const id = fromId(params.id);
  const existing = await repo.findCategory(ctx.db, id);
  if (existing === null) throw new DomainError('CMS_CATEGORY_NOT_FOUND');

  const parentId = await resolveParent(ctx, body.parentId, id);
  const row = await repo.updateCategory(ctx.db, id, {
    parentId,
    title: body.title,
    intro: body.intro,
    imageUrl: body.imageUrl,
    status: body.status,
    sortOrder: body.sortOrder,
  });
  if (row === null) throw new DomainError('CMS_CATEGORY_NOT_FOUND');
  return toWire(row, await repo.categoryArticleCount(ctx.db, id));
}

export async function setStatus(
  ctx: Ctx,
  params: { id: string },
  body: { status: ArticleCategoryStatus },
): Promise<ArticleCategory> {
  const id = fromId(params.id);
  const row = await repo.updateCategory(ctx.db, id, { status: body.status });
  if (row === null) throw new DomainError('CMS_CATEGORY_NOT_FOUND');
  return toWire(row, await repo.categoryArticleCount(ctx.db, id));
}

/**
 * Soft delete, and only of an empty category.
 *
 * `articles.category_id` is `restrict`, so a hard delete would be refused by
 * the database anyway; refusing here means the operator is told *what* is in
 * the way — how many children, how many articles — instead of reading a 500.
 * Articles are counted whatever their status: a draft filed under the category
 * still points at it.
 */
export async function remove(ctx: Ctx, params: { id: string }): Promise<{ deleted: true }> {
  const id = fromId(params.id);
  const existing = await repo.findCategory(ctx.db, id);
  if (existing === null) throw new DomainError('CMS_CATEGORY_NOT_FOUND');

  const [children, articles] = await Promise.all([
    repo.categoryChildCount(ctx.db, id),
    repo.categoryArticleCount(ctx.db, id),
  ]);
  if (children > 0 || articles > 0) {
    throw new DomainError('CMS_CATEGORY_NOT_EMPTY', { details: { children, articles } });
  }

  const affected = await repo.softDeleteCategory(ctx.db, id, ctx.clock.now());
  if (affected === 0) throw new DomainError('CMS_CATEGORY_NOT_FOUND');
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

/**
 * The visible tree, nested two deep.
 *
 * Hidden categories are dropped with their children: hiding a parent that left
 * its children on the tab bar would leave orphans pointing at an empty list.
 */
export async function publicList(ctx: Ctx): Promise<PublicArticleCategoryList> {
  const rows = await repo.listVisibleCategories(ctx.db);
  const tops = rows.filter((row) => row.parentId === null);
  const visible = new Set(tops.map((row) => row.id));
  return {
    items: tops.map((top) => ({
      id: toId(top.id),
      title: top.title,
      imageUrl: top.imageUrl,
      children: rows
        .filter(
          (row) => row.parentId !== null && visible.has(row.parentId) && row.parentId === top.id,
        )
        .map((child) => ({ id: toId(child.id), title: child.title, imageUrl: child.imageUrl })),
    })),
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Validates the requested parent and returns the column value.
 *
 * `self` is the category being edited, or `null` on create.
 */
async function resolveParent(ctx: Ctx, parentId: string | null, self: number | null) {
  if (parentId === null) return null;
  const wanted = fromId(parentId);
  if (self !== null && wanted === self) throw new DomainError('CMS_CATEGORY_CYCLE');

  const parent = await repo.findCategory(ctx.db, wanted);
  if (parent === null) throw new DomainError('CMS_CATEGORY_NOT_FOUND');
  // The tree is two deep, so "a descendant of me" is exactly "a child of me".
  if (self !== null && parent.parentId === self) throw new DomainError('CMS_CATEGORY_CYCLE');
  if (parent.parentId !== null) throw new DomainError('CMS_CATEGORY_TOO_DEEP');

  if (self !== null && (await repo.categoryChildCount(ctx.db, self)) > 0) {
    throw new DomainError('CMS_CATEGORY_TOO_DEEP');
  }
  return wanted;
}

/** Parents in sort order, each followed by its own children in sort order. */
function flatten(rows: (repo.CategoryRow & { articleCount: number })[]): ArticleCategory[] {
  const byParent = new Map<number, (repo.CategoryRow & { articleCount: number })[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const bucket = byParent.get(row.parentId);
    if (bucket) bucket.push(row);
    else byParent.set(row.parentId, [row]);
  }
  const out: ArticleCategory[] = [];
  for (const row of rows) {
    // A child whose parent is filtered out still shows, or a keyword search
    // would return nothing for a term that only matches sub-categories.
    if (row.parentId !== null && rows.some((other) => other.id === row.parentId)) continue;
    out.push(toWire(row, row.articleCount));
    for (const child of byParent.get(row.id) ?? []) out.push(toWire(child, child.articleCount));
  }
  return out;
}

function toWire(row: repo.CategoryRow, articleCount: number): ArticleCategory {
  return {
    id: toId(row.id),
    parentId: row.parentId === null ? null : toId(row.parentId),
    title: row.title,
    intro: row.intro,
    imageUrl: row.imageUrl,
    status: row.status,
    sortOrder: row.sortOrder,
    depth: row.parentId === null ? 0 : 1,
    articleCount,
    createdAt: row.createdAt.toISOString(),
  };
}
