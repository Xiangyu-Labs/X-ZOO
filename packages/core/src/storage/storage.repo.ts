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
 * The dedupe lookup: same bytes, same driver, still alive.
 *
 * Scoped by driver because the key means nothing across drivers, and ordered
 * by id so two concurrent uploads of the same file converge on the same row
 * rather than on whichever the planner happened to return.
 */
export async function findByDigest(
  db: DbOrTx,
  sha256: string,
  driver: 'local' | 's3',
): Promise<AttachmentRow | undefined> {
  const [row] = await db
    .select(ATTACHMENT_COLUMNS)
    .from(attachments)
    .where(and(eq(attachments.sha256, sha256), eq(attachments.driver, driver), ATTACHMENT_ALIVE))
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
        sql`${attachments.deletedAt} is not null`,
        sql`${attachments.deletedAt} < ${before}`,
        sql`not exists (select 1 from ${attachments} live
              where live.storage_key = ${attachments.storageKey} and live.deleted_at is null)`,
      ),
    )
    .orderBy(asc(attachments.id))
    .limit(limit);
}

/**
 * Tables that record what happened rather than what the shop shows. A URL in
 * an audit entry or a job payload is not a picture on a page, and these are
 * the tables that grow without bound, so the reference scan skips them.
 * Everything else is scanned — a table added later is covered without anyone
 * remembering to list it here.
 */
const NOT_CONTENT_TABLES = [
  'attachments',
  'attachment_categories',
  'audit_logs',
  'user_sessions',
  'admin_api_tokens',
  'oauth_clients',
  'effects',
  'failed_jobs',
  'payment_attempts',
  'payment_callbacks',
  'payment_exceptions',
  'capital_flows',
  'wechat_trade_orders',
  'notification_messages',
  'sms_logs',
  'product_events',
  'user_visits',
  'search_logs',
  'order_status_logs',
  'refund_logs',
  'presale_stock_ledger',
  'content_security_checks',
  'wechat_qrcode_scans',
  'cities',
];

/** The text-like column types a URL can sit in. */
const TEXT_UDTS = ['text', 'varchar', 'bpchar', 'json', 'jsonb', '_text', '_varchar'];

const regexpLiteral = (text: string) => text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');

/**
 * Which of `needles` some content still contains, anywhere in a text, JSON or
 * text-array column of a content table: a product's pictures and description,
 * a page document and its revisions, an article, a config value, an avatar, an
 * order line's snapshot.
 *
 * One pass per table, whatever the number of needles. A needle is matched as a
 * substring, so a false hit keeps a file that could have gone — the safe side
 * for a job whose other mistake is a broken picture.
 */
export async function referencedNeedles(
  db: DbOrTx,
  needles: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (needles.length === 0) return found;

  const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = current_schema()
       and t.table_type = 'BASE TABLE'
       and c.udt_name in (${sql.join(
         TEXT_UDTS.map((udt) => sql`${udt}`),
         sql`, `,
       )})
       and c.table_name not in (${sql.join(
         NOT_CONTENT_TABLES.map((table) => sql`${table}`),
         sql`, `,
       )})
     order by c.table_name, c.ordinal_position`);

  const byTable = new Map<string, string[]>();
  for (const row of columns.rows) {
    byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
  }

  for (const [table, names] of byTable) {
    const pending = needles.filter((needle) => !found.has(needle));
    if (pending.length === 0) break;
    const pattern = `(${pending.map(regexpLiteral).join('|')})`;
    const text = sql.join(
      names.map((name) => sql`${sql.identifier(name)}::text`),
      sql`, `,
    );
    const hits = await db.execute<{ needle: string }>(sql`
      select distinct m[1] as needle
        from ${sql.identifier(table)},
             regexp_matches(concat_ws(' ', ${text}), ${pattern}, 'g') as m`);
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
