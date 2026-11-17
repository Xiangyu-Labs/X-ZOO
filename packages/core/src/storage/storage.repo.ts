import type { DbOrTx } from '@shop/db';
import { attachmentCategories, attachments } from '@shop/db/schema/storage';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  like,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { containsPattern } from '../kernel/like';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * The only file in the `storage` domain that touches Drizzle tables.
 *
 * Statements, not decisions. Two things are worth knowing before reading:
 *
 *  - **soft delete.** Attachments and categories carry `deleted_at`. A file
 *    removed from the library is not removed from the bucket by the same
 *    request — a product description may still point at it — so the row is
 *    tombstoned and `storage.cleanOrphans` sweeps the bytes later.
 *  - **the materialised path.** A category's `path` is `/` for a root and
 *    `/1/7/` for a grandchild, so "everything under this folder" is one
 *    `LIKE '/1/%'` rather than a recursive CTE, and re-parenting is a prefix
 *    rewrite of the subtree.
 */

const ATTACHMENT_ALIVE = sql`${attachments.deletedAt} is null`;
const CATEGORY_ALIVE = sql`${attachmentCategories.deletedAt} is null`;

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export interface CategoryRow {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  sortOrder: number;
}

const CATEGORY_COLUMNS = {
  id: attachmentCategories.id,
  parentId: attachmentCategories.parentId,
  name: attachmentCategories.name,
  path: attachmentCategories.path,
  sortOrder: attachmentCategories.sortOrder,
} as const;

export async function listCategories(db: DbOrTx): Promise<CategoryRow[]> {
  return db
    .select(CATEGORY_COLUMNS)
    .from(attachmentCategories)
    .where(CATEGORY_ALIVE)
    .orderBy(asc(attachmentCategories.sortOrder), asc(attachmentCategories.id));
}

export async function findCategory(db: DbOrTx, id: number): Promise<CategoryRow | undefined> {
  const [row] = await db
    .select(CATEGORY_COLUMNS)
    .from(attachmentCategories)
    .where(and(eq(attachmentCategories.id, id), CATEGORY_ALIVE))
    .limit(1);
  return row;
}

/** Direct-member counts, keyed by category id. Children are not counted in. */
export async function categoryAttachmentCounts(db: DbOrTx): Promise<Map<number, number>> {
  const rows = await db
    .select({ categoryId: attachments.categoryId, total: count() })
    .from(attachments)
    .where(and(ATTACHMENT_ALIVE, sql`${attachments.categoryId} is not null`))
    .groupBy(attachments.categoryId);
  const out = new Map<number, number>();
  for (const row of rows) {
    if (row.categoryId !== null) out.set(row.categoryId, Number(row.total));
  }
  return out;
}

export async function insertCategory(
  db: DbOrTx,
  values: { parentId: number | null; name: string; path: string; sortOrder: number },
): Promise<CategoryRow> {
  const [row] = await db.insert(attachmentCategories).values(values).returning(CATEGORY_COLUMNS);
  if (!row) throw new Error('storage: 分类写入未返回行');
  return row;
}

export async function updateCategory(
  db: DbOrTx,
  id: number,
  values: { parentId: number | null; name: string; path: string; sortOrder: number },
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, attachmentCategories, {
    where: and(eq(attachmentCategories.id, id), CATEGORY_ALIVE),
    set: { ...values, updatedAt: now },
  });
}

/** Everything strictly below `path + id`, for a re-parent or a delete check. */
export async function descendantCategoryIds(db: DbOrTx, category: CategoryRow): Promise<number[]> {
  const prefix = `${category.path}${category.id}/`;
  const rows = await db
    .select({ id: attachmentCategories.id })
    .from(attachmentCategories)
    .where(and(like(attachmentCategories.path, `${prefix}%`), CATEGORY_ALIVE));
  return rows.map((row) => row.id);
}

/**
 * Rewrites the `path` prefix of a whole subtree in one statement.
 *
 * Re-parenting `/1/7/` under `/2/` turns every `/1/7/%` into `/2/9/%`. Done
 * row by row this is N statements and a window where the tree is inconsistent;
 * done here it is one.
 */
export async function reparentSubtree(
  db: DbOrTx,
  oldPrefix: string,
  newPrefix: string,
  now: Date,
): Promise<number> {
  const result = await conditionalUpdate(db, attachmentCategories, {
    where: and(like(attachmentCategories.path, `${oldPrefix}%`), CATEGORY_ALIVE),
    set: {
      // The `::int` cast is load-bearing: an untyped parameter makes
      // PostgreSQL read `substring(text from text)`, the *regex* form, which
      // returns NULL when the pattern does not match and violates NOT NULL.
      path: sql`${newPrefix} || substring(${attachmentCategories.path} from ${oldPrefix.length + 1}::int)`,
      updatedAt: now,
    },
  });
  return result.affected;
}

/**
 * Locks a live category for reading, blocking a concurrent delete of it.
 *
 * **Why this exists.** The delete guard is a `NOT EXISTS` over `attachments`
 * inside the UPDATE, and under READ COMMITTED that subquery cannot see an
 * uncommitted insert from another transaction — while that other transaction's
 * "is the folder alive" read cannot see the uncommitted soft-delete. Both
 * commit, and a live file sits in a deleted folder, invisible in the library.
 * A guard inside one statement only serialises writers touching the *same
 * row*; these two touch different tables.
 *
 * So every path that files something into a category takes this lock first, in
 * the same transaction as the insert, and `lockCategoryForDelete` takes the
 * conflicting `FOR UPDATE`. Returns `null` when the category is gone — which,
 * after waiting behind a delete, is exactly what the loser must see.
 *
 * `FOR SHARE`, not `FOR KEY SHARE`: the delete updates `deleted_at`, a
 * non-key column, and `FOR KEY SHARE` does not conflict with that.
 */
export async function lockCategoryAlive(tx: DbOrTx, id: number): Promise<CategoryRow | null> {
  const [row] = await tx
    .select(CATEGORY_COLUMNS)
    .from(attachmentCategories)
    .where(and(eq(attachmentCategories.id, id), CATEGORY_ALIVE))
    .limit(1)
    .for('share');
  return row ?? null;
}

/**
 * The other side of `lockCategoryAlive`: `FOR UPDATE` on the category row, so
 * a delete waits for any upload filing into it and then re-reads.
 *
 * Returns `null` when there is no such row at all. A row that exists but is
 * already soft-deleted still comes back — the caller's conditional update
 * carries the `deleted_at is null` guard and will simply lose.
 */
export async function lockCategoryForDelete(
  tx: DbOrTx,
  id: number,
): Promise<{ id: number } | null> {
  const [row] = await tx
    .select({ id: attachmentCategories.id })
    .from(attachmentCategories)
    .where(eq(attachmentCategories.id, id))
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Soft-deletes a category only while it is empty of children and of files.
 *
 * Run this as its own statement **after** `lockCategoryForDelete`, never as the
 * first thing the transaction does: in READ COMMITTED each statement takes a
 * fresh snapshot, so the `NOT EXISTS` subqueries here see everything that
 * committed while we waited for the lock.
 */
export async function deleteCategoryIfEmpty(
  db: DbOrTx,
  id: number,
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, attachmentCategories, {
    where: and(
      eq(attachmentCategories.id, id),
      CATEGORY_ALIVE,
      sql`not exists (select 1 from ${attachmentCategories} c
            where c.parent_id = ${id} and c.deleted_at is null)`,
      sql`not exists (select 1 from ${attachments} a
            where a.category_id = ${id} and a.deleted_at is null)`,
    ),
    set: { deletedAt: now, updatedAt: now },
  });
}

export async function categoryNameTaken(
  db: DbOrTx,
  parentId: number | null,
  name: string,
  exceptId?: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: attachmentCategories.id })
    .from(attachmentCategories)
    .where(
      allOf(
        parentId === null
          ? isNull(attachmentCategories.parentId)
          : eq(attachmentCategories.parentId, parentId),
        eq(attachmentCategories.name, name),
        CATEGORY_ALIVE,
        exceptId === undefined ? undefined : sql`${attachmentCategories.id} <> ${exceptId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

export interface AttachmentRow {
  id: number;
  categoryId: number | null;
  storageKey: string;
  driver: 'local' | 's3';
  url: string;
  name: string;
  originalName: string | null;
  kind: 'image' | 'video' | 'audio' | 'file';
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: Date;
}

const ATTACHMENT_COLUMNS = {
  id: attachments.id,
  categoryId: attachments.categoryId,
  storageKey: attachments.storageKey,
  driver: attachments.driver,
  url: attachments.url,
  name: attachments.name,
  originalName: attachments.originalName,
  kind: attachments.kind,
  mime: attachments.mime,
  size: attachments.size,
  sha256: attachments.sha256,
  width: attachments.width,
  height: attachments.height,
  durationMs: attachments.durationMs,
  createdAt: attachments.createdAt,
} as const;

export interface AttachmentListArgs {
  categoryIds?: readonly number[] | undefined;
  keyword?: string | undefined;
  kind?: 'image' | 'video' | 'audio' | 'file' | undefined;
  sortBy?: 'id' | 'createdAt' | 'size' | 'name' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

function attachmentFilters(args: AttachmentListArgs): SQL | undefined {
  const keyword = args.keyword?.trim();
  return allOf(
    ATTACHMENT_ALIVE,
    args.categoryIds === undefined
      ? undefined
      : args.categoryIds.length === 0
        ? sql`false`
        : inArray(attachments.categoryId, [...args.categoryIds]),
    args.kind === undefined ? undefined : eq(attachments.kind, args.kind),
    keyword
      ? or(
          ilike(attachments.name, containsPattern(keyword)),
          ilike(attachments.originalName, containsPattern(keyword)),
        )
      : undefined,
  );
}

export async function listAttachments(
  db: DbOrTx,
  args: AttachmentListArgs,
): Promise<{ items: AttachmentRow[]; total: number }> {
  const where = attachmentFilters(args);
  const column =
    args.sortBy === 'size'
      ? attachments.size
      : args.sortBy === 'name'
        ? attachments.name
        : args.sortBy === 'createdAt'
          ? attachments.createdAt
          : attachments.id;
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const [items, [totals]] = await Promise.all([
    db
      .select(ATTACHMENT_COLUMNS)
      .from(attachments)
      .where(where)
      // `id` breaks ties so paging cannot repeat or skip a row.
      .orderBy(direction(column), desc(attachments.id))
      .limit(args.limit)
      .offset(args.offset),
    db.select({ total: count() }).from(attachments).where(where),
  ]);
  return { items, total: Number(totals?.total ?? 0) };
}

export async function findAttachment(db: DbOrTx, id: number): Promise<AttachmentRow | undefined> {
  const [row] = await db
    .select(ATTACHMENT_COLUMNS)
    .from(attachments)
    .where(and(eq(attachments.id, id), ATTACHMENT_ALIVE))
    .limit(1);
  return row;
}

/**
 * The dedupe lookup: same bytes, same driver and bucket, still alive.
 *
 * Scoped by driver and bucket because a key means nothing across drivers or
 * buckets, and ordered by id so two concurrent uploads of the same file
 * converge on the same row rather than on whichever the planner happened to
 * return.
 */
export async function findByDigest(
  db: DbOrTx,
  sha256: string,
  driver: 'local' | 's3',
  bucket: string | null = null,
): Promise<AttachmentRow | undefined> {
  const [row] = await db
    .select(ATTACHMENT_COLUMNS)
    .from(attachments)
    .where(
      and(
        eq(attachments.sha256, sha256),
        eq(attachments.driver, driver),
        bucket === null ? isNull(attachments.bucket) : eq(attachments.bucket, bucket),
        ATTACHMENT_ALIVE,
      ),
    )
    .orderBy(asc(attachments.id))
    .limit(1);
  return row;
}

export interface NewAttachmentValues {
  categoryId: number | null;
  storageKey: string;
  driver: 'local' | 's3';
  bucket: string | null;
  url: string;
  name: string;
  originalName: string | null;
  kind: 'image' | 'video' | 'audio' | 'file';
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  uploadedByAdminId: number | null;
  uploadedByUserId: number | null;
}

/**
 * Whether a live image attachment answers at exactly this URL. Any uploader:
 * digest dedupe hands a shopper the row somebody else stored first, and the
 * URL is equally ours either way.
 */
export async function liveImageUrlExists(db: DbOrTx, url: string): Promise<boolean> {
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(eq(attachments.url, url), eq(attachments.kind, 'image'), isNull(attachments.deletedAt)),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Live images above `afterId`, in id order: the image-variant backfill's
 * cursor. Only the ids — each picture is re-read by `findAttachment` when its
 * turn comes, so a row deleted meanwhile is skipped rather than processed.
 */
export async function listImageAttachmentIds(
  db: DbOrTx,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        sql`${attachments.id} > ${afterId}`,
        eq(attachments.kind, 'image'),
        isNull(attachments.deletedAt),
      ),
    )
    .orderBy(asc(attachments.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function insertAttachment(
  db: DbOrTx,
  values: NewAttachmentValues,
): Promise<AttachmentRow> {
  const [row] = await db.insert(attachments).values(values).returning(ATTACHMENT_COLUMNS);
  if (!row) throw new Error('storage: 素材写入未返回行');
  return row;
}

export async function updateAttachment(
  db: DbOrTx,
  id: number,
  values: { name: string; categoryId: number | null },
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, attachments, {
    where: and(eq(attachments.id, id), ATTACHMENT_ALIVE),
    set: { ...values, updatedAt: now },
  });
}

/** Ids of the rows that are alive right now, for reporting `skippedIds`. */
export async function aliveAttachmentIds(db: DbOrTx, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(inArray(attachments.id, [...ids]), ATTACHMENT_ALIVE));
  return new Set(rows.map((row) => row.id));
}

export async function softDeleteAttachments(
  db: DbOrTx,
  ids: readonly number[],
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await conditionalUpdate(db, attachments, {
    where: and(inArray(attachments.id, [...ids]), ATTACHMENT_ALIVE),
    set: { deletedAt: now, updatedAt: now },
  });
  return result.affected;
}

export async function moveAttachments(
  db: DbOrTx,
  ids: readonly number[],
  categoryId: number | null,
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await conditionalUpdate(db, attachments, {
    where: and(inArray(attachments.id, [...ids]), ATTACHMENT_ALIVE),
    set: { categoryId, updatedAt: now },
  });
  return result.affected;
}

// ---------------------------------------------------------------------------
// housekeeping
// ---------------------------------------------------------------------------

export interface OrphanRow {
  id: number;
  storageKey: string;
  driver: 'local' | 's3';
  sha256: string;
}

/**
 * Tombstoned rows old enough to sweep.
 *
 * The `not exists` clause is the safety catch: the same bytes may have been
 * uploaded twice and deduped onto one key, so deleting the object because one
 * row was tombstoned would break the row that is still alive.
 */
export async function listSweepableAttachments(
  db: DbOrTx,
  before: Date,
  limit: number,
  target: { driver: 'local' | 's3'; bucket: string | null },
): Promise<OrphanRow[]> {
  return db
    .select({
      id: attachments.id,
      storageKey: attachments.storageKey,
      driver: attachments.driver,
      sha256: attachments.sha256,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.driver, target.driver),
        target.bucket === null ? isNull(attachments.bucket) : eq(attachments.bucket, target.bucket),
        sql`${attachments.deletedAt} is not null`,
        sql`${attachments.deletedAt} < ${before}`,
        sql`not exists (select 1 from ${attachments} live
              where live.storage_key = ${attachments.storageKey} and live.deleted_at is null)`,
      ),
    )
    .orderBy(asc(attachments.id))
    .limit(limit);
}

const regexpLiteral = (text: string) => text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');

interface ContentSource {
  table: string;
  /** SQL expression yielding a single text string per row that may hold attachment URLs/keys. */
  expr: SQL;
  /** Skips rows whose media columns are all NULL / empty before running regex checks. */
  nonEmpty?: SQL;
}

const colText = (name: string) => sql`${sql.identifier(name)}::text`;

function colsSource(table: string, columns: readonly string[], nonEmpty?: SQL): ContentSource {
  const expr =
    columns.length === 1
      ? colText(columns[0]!)
      : sql`concat_ws(' ', ${sql.join(columns.map(colText), sql`, `)})`;
  return nonEmpty === undefined ? { table, expr } : { table, expr, nonEmpty };
}

/**
 * Curated media-bearing tables and columns, ordered from smallest config/catalog
 * tables to largest transactional/user tables so `pending.length === 0` exits
 * early without touching large tables.
 *
 * Non-media tables (`orders`, `shipments`, `admins`, `user_addresses`,
 * `product_virtual_cards`, logs, stats, etc.) are never scanned, and
 * `order_items` reads only the two image keys out of `snapshot`.
 */
export const CONTENT_MEDIA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  config_values: ['value'],
  agreements: ['content_html'],
  decor_documents: ['draft'],
  decor_revisions: ['content'],
  product_categories: ['icon_url', 'banner_url'],
  products: ['image_url', 'card_image_url', 'slider_images', 'video_url', 'video_poster_url'],
  product_descriptions: ['content_html', 'blocks'],
  product_spec_values: ['image_url'],
  product_skus: ['image_url'],
  product_labels: ['image_url'],
  product_protections: ['icon_url'],
  article_categories: ['image_url'],
  articles: ['cover_image_url', 'source_url'],
  article_contents: ['content_html'],
  groupbuy_activities: ['image_url', 'slider_images'],
  presale_activities: ['image_url', 'slider_images'],
  wechat_auto_replies: ['payload'],
  wechat_qrcodes: ['image_url', 'reply_payload'],
  wechat_mini_codes: ['storage_key', 'url'],
  wechat_media: ['url'],
  product_reviews: ['author_avatar_url', 'images'],
  refunds: ['images'],
  groupbuy_members: ['avatar_url'],
  wechat_identities: ['avatar_url'],
  users: ['avatar_url'],
  order_items: ['snapshot'],
};

const CONTENT_SOURCES: readonly ContentSource[] = [
  colsSource('config_values', ['value']),
  colsSource('agreements', ['content_html'], sql`content_html is not null`),
  colsSource('decor_documents', ['draft']),
  colsSource('decor_revisions', ['content']),
  colsSource(
    'product_categories',
    ['icon_url', 'banner_url'],
    sql`(icon_url is not null or banner_url is not null)`,
  ),
  colsSource('products', [
    'image_url',
    'card_image_url',
    'slider_images',
    'video_url',
    'video_poster_url',
  ]),
  colsSource('product_descriptions', ['content_html', 'blocks']),
  colsSource('product_spec_values', ['image_url'], sql`image_url is not null`),
  colsSource('product_skus', ['image_url'], sql`image_url is not null`),
  colsSource('product_labels', ['image_url'], sql`image_url is not null`),
  colsSource('product_protections', ['icon_url'], sql`icon_url is not null`),
  colsSource('article_categories', ['image_url'], sql`image_url is not null`),
  colsSource(
    'articles',
    ['cover_image_url', 'source_url'],
    sql`(cover_image_url is not null or source_url is not null)`,
  ),
  colsSource('article_contents', ['content_html']),
  colsSource('groupbuy_activities', ['image_url', 'slider_images']),
  colsSource('presale_activities', ['image_url', 'slider_images']),
  colsSource('wechat_auto_replies', ['payload']),
  colsSource('wechat_qrcodes', ['image_url', 'reply_payload']),
  colsSource('wechat_mini_codes', ['storage_key', 'url']),
  colsSource('wechat_media', ['url'], sql`url is not null`),
  colsSource(
    'product_reviews',
    ['author_avatar_url', 'images'],
    sql`(author_avatar_url is not null or jsonb_array_length(images) > 0)`,
  ),
  colsSource('refunds', ['images'], sql`jsonb_array_length(images) > 0`),
  colsSource('groupbuy_members', ['avatar_url'], sql`avatar_url is not null`),
  colsSource('wechat_identities', ['avatar_url'], sql`avatar_url is not null`),
  colsSource('users', ['avatar_url'], sql`avatar_url is not null`),
  {
    table: 'order_items',
    expr: sql`concat_ws(' ', snapshot->>'productImageUrl', snapshot->>'skuImageUrl')`,
    nonEmpty: sql`(snapshot->>'productImageUrl' is not null or snapshot->>'skuImageUrl' is not null)`,
  },
];

/**
 * Which of `needles` some content still contains in a media-bearing column.
 *
 * Pre-filters rows with `nonEmpty` and `~` (fast regex match without capture
 * extraction) before invoking `regexp_matches(..., 'g')` only on matching rows.
 */
export async function referencedNeedles(
  db: DbOrTx,
  needles: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (needles.length === 0) return found;

  for (const source of CONTENT_SOURCES) {
    const pending = needles.filter((needle) => !found.has(needle));
    if (pending.length === 0) break;
    const pattern = `(${pending.map(regexpLiteral).join('|')})`;
    const whereClause = source.nonEmpty
      ? sql`${source.nonEmpty} and ${source.expr} ~ ${pattern}`
      : sql`${source.expr} is not null and ${source.expr} ~ ${pattern}`;
    const hits = await db.execute<{ needle: string }>(sql`
      with matched as (
        select ${source.expr} as body
          from ${sql.identifier(source.table)}
         where ${whereClause}
      )
      select distinct m[1] as needle
        from matched,
             regexp_matches(matched.body, ${pattern}, 'g') as m`);
    for (const hit of hits.rows) found.add(hit.needle);
  }
  return found;
}

/**
 * Put still-referenced tombstones to the back of the queue: they are asked
 * about again a full retention later instead of filling every batch.
 */
export async function deferAttachments(
  db: DbOrTx,
  ids: readonly number[],
  now: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(attachments)
    .set({ deletedAt: now })
    .where(and(inArray(attachments.id, [...ids]), sql`${attachments.deletedAt} is not null`));
}

/** Hard delete, once the bytes are gone. Only ever called by the sweeper. */
export async function purgeAttachments(db: DbOrTx, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.delete(attachments).where(inArray(attachments.id, [...ids]));
  return (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
}

/** Library totals for the dashboard tile. */
export async function attachmentTotals(db: DbOrTx): Promise<{ files: number; bytes: number }> {
  const [row] = await db
    .select({ files: count(), bytes: sum(attachments.size) })
    .from(attachments)
    .where(ATTACHMENT_ALIVE);
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}
