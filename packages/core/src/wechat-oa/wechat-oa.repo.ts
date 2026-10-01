import type { DbOrTx, Tx } from '@shop/db';
import { attachments } from '@shop/db/schema/storage';
import { users } from '@shop/db/schema/user';
import {
  wechatAutoReplies,
  wechatIdentities,
  wechatMedia,
  wechatOaMenus,
  wechatQrcodeCategories,
  wechatQrcodeScans,
  wechatQrcodes,
  type NewWechatQrcodeScan,
  type WechatAutoReply,
  type WechatMedium,
  type WechatMenuButton,
  type WechatOaMenu,
  type WechatQrcode,
  type WechatQrcodeCategory,
} from '@shop/db/schema/wechat';
import type { WechatMenuButtonShape } from '@shop/contracts/wechat-oa/schemas';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import { containsPattern } from '../kernel/like';

/**
 * The button tree crosses the boundary in the contract's shape.
 *
 * `WechatMenuButton` (the column's type) spells its optional fields without
 * `| undefined`, which `exactOptionalPropertyTypes` makes a different type from
 * the zod-inferred one the routes carry. They are the same JSON; the cast is
 * confined to this file rather than repeated in every service.
 */
export type MenuButtons = WechatMenuButtonShape[];

export type {
  WechatAutoReply,
  WechatMedium,
  WechatMenuButton,
  WechatOaMenu,
  WechatQrcode,
  WechatQrcodeCategory,
};

/**
 * Every Drizzle statement the Official Account domain runs.
 *
 * Three of them carry a decision the services depend on:
 *
 * - **`activateMenu` clears the flag before it sets one.** The partial unique
 *   index `wechat_oa_menus_active_uq` allows exactly one active menu, so the
 *   two halves belong in one transaction or the shop has no live menu in
 *   between. That is not enough by itself: with no menu active yet the first
 *   statement locks nothing, two publishes both reach the second one and one of
 *   them loses on the constraint — which is why `menu.publish` retries once.
 * - **`bumpQrcodeCounters` is `UPDATE … SET n = n + 1`, never
 *   read-modify-write.** Scans arrive concurrently from WeChat's own fan-out;
 *   reading 128 in two requests and writing 129 twice would make the counter
 *   drift low.
 * - **`findReplyForKeyword` sorts exact before contains and then by
 *   `sort_order`.** The reply engine must be deterministic: the same message
 *   twice has to produce the same answer, or an operator debugging a keyword
 *   sees it work every other time.
 */

/** PostgreSQL's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether this is PostgreSQL refusing a duplicate, optionally on one named index.
 *
 * Every "is this name free?" check in this domain is a read followed by a write,
 * and the gap between them belongs to whoever else is clicking 保存. The index
 * is what actually decides; this is how the service reads that decision and
 * answers 409 instead of 500. Drizzle wraps the driver error, and a pool error
 * can wrap it again, so the chain is walked rather than peeled once.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION) {
      return constraint === undefined || candidate.constraint === constraint;
    }
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------

export async function listMenus(
  db: DbOrTx,
  args: { offset: number; limit: number },
): Promise<{ rows: WechatOaMenu[]; total: number }> {
  const where = isNull(wechatOaMenus.deletedAt);
  const rows = await db
    .select()
    .from(wechatOaMenus)
    .where(where)
    .orderBy(desc(wechatOaMenus.isActive), desc(wechatOaMenus.id))
    .offset(args.offset)
    .limit(args.limit);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(wechatOaMenus)
    .where(where);
  return { rows, total: count?.total ?? 0 };
}

export async function findMenu(db: DbOrTx, id: number): Promise<WechatOaMenu | undefined> {
  const rows = await db
    .select()
    .from(wechatOaMenus)
    .where(and(eq(wechatOaMenus.id, id), isNull(wechatOaMenus.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function findActiveMenu(db: DbOrTx): Promise<WechatOaMenu | undefined> {
  const rows = await db
    .select()
    .from(wechatOaMenus)
    .where(and(eq(wechatOaMenus.isActive, true), isNull(wechatOaMenus.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function insertMenu(
  db: DbOrTx,
  values: { name: string; buttons: MenuButtons },
): Promise<WechatOaMenu> {
  const [row] = await db
    .insert(wechatOaMenus)
    .values({ name: values.name, buttons: values.buttons as WechatMenuButton[] })
    .returning();
  return row!;
}

export async function updateMenu(
  db: DbOrTx,
  id: number,
  patch: { name?: string; buttons?: MenuButtons; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatOaMenus, {
    where: and(eq(wechatOaMenus.id, id), isNull(wechatOaMenus.deletedAt)),
    set: {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.buttons === undefined ? {} : { buttons: patch.buttons as WechatMenuButton[] }),
      updatedAt: patch.now,
    },
  });
}

export async function softDeleteMenu(
  db: DbOrTx,
  id: number,
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatOaMenus, {
    where: and(
      eq(wechatOaMenus.id, id),
      eq(wechatOaMenus.isActive, false),
      isNull(wechatOaMenus.deletedAt),
    ),
    set: { deletedAt: now, updatedAt: now },
  });
}

/** Both halves of "this menu is now the live one", in one transaction. */
export async function activateMenu(tx: Tx, id: number, now: Date): Promise<void> {
  await tx
    .update(wechatOaMenus)
    .set({ isActive: false, updatedAt: now })
    .where(and(eq(wechatOaMenus.isActive, true), isNull(wechatOaMenus.deletedAt)));
  await tx
    .update(wechatOaMenus)
    .set({
      isActive: true,
      publishedAt: now,
      publishError: null,
      publishErrorSummary: null,
      updatedAt: now,
    })
    .where(eq(wechatOaMenus.id, id));
}

/** `error` is raw (技术详情); `summary` is the Chinese line staff read. */
export async function recordMenuPublishError(
  db: DbOrTx,
  id: number,
  failure: { error: string; summary: string },
  now: Date,
): Promise<void> {
  await db
    .update(wechatOaMenus)
    .set({
      publishError: failure.error.slice(0, 255),
      publishErrorSummary: failure.summary.slice(0, 255),
      updatedAt: now,
    })
    .where(eq(wechatOaMenus.id, id));
}

// ---------------------------------------------------------------------------
// auto replies
// ---------------------------------------------------------------------------

export interface ReplyFilter {
  triggerKind?: 'subscribe' | 'keyword' | 'default';
  keyword?: string;
  isEnabled?: boolean;
  offset: number;
  limit: number;
}

export async function listReplies(
  db: DbOrTx,
  filter: ReplyFilter,
): Promise<{ rows: WechatAutoReply[]; total: number }> {
  const where = allOf(
    isNull(wechatAutoReplies.deletedAt),
    filter.triggerKind === undefined
      ? undefined
      : eq(wechatAutoReplies.triggerKind, filter.triggerKind),
    filter.keyword === undefined
      ? undefined
      : ilike(wechatAutoReplies.keyword, containsPattern(filter.keyword)),
    filter.isEnabled === undefined ? undefined : eq(wechatAutoReplies.isEnabled, filter.isEnabled),
  );
  const rows = await db
    .select()
    .from(wechatAutoReplies)
    .where(where)
    .orderBy(asc(wechatAutoReplies.sortOrder), desc(wechatAutoReplies.id))
    .offset(filter.offset)
    .limit(filter.limit);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(wechatAutoReplies)
    .where(where);
  return { rows, total: count?.total ?? 0 };
}

export async function findReply(db: DbOrTx, id: number): Promise<WechatAutoReply | undefined> {
  const rows = await db
    .select()
    .from(wechatAutoReplies)
    .where(and(eq(wechatAutoReplies.id, id), isNull(wechatAutoReplies.deletedAt)))
    .limit(1);
  return rows[0];
}

export type NewReply = typeof wechatAutoReplies.$inferInsert;

export async function insertReply(db: DbOrTx, values: NewReply): Promise<WechatAutoReply> {
  const [row] = await db.insert(wechatAutoReplies).values(values).returning();
  return row!;
}

export async function updateReply(
  db: DbOrTx,
  id: number,
  patch: Partial<NewReply> & { now: Date },
): Promise<ConditionalUpdateResult> {
  const { now, ...set } = patch;
  return conditionalUpdate(db, wechatAutoReplies, {
    where: and(eq(wechatAutoReplies.id, id), isNull(wechatAutoReplies.deletedAt)),
    set: { ...set, updatedAt: now },
  });
}

export async function softDeleteReply(
  db: DbOrTx,
  id: number,
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatAutoReplies, {
    where: and(eq(wechatAutoReplies.id, id), isNull(wechatAutoReplies.deletedAt)),
    set: { deletedAt: now, updatedAt: now },
  });
}

/** The singleton replies: `subscribe` and `default`. */
export async function findSingletonReply(
  db: DbOrTx,
  triggerKind: 'subscribe' | 'default',
): Promise<WechatAutoReply | undefined> {
  const rows = await db
    .select()
    .from(wechatAutoReplies)
    .where(
      and(
        eq(wechatAutoReplies.triggerKind, triggerKind),
        eq(wechatAutoReplies.isEnabled, true),
        isNull(wechatAutoReplies.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Every enabled keyword reply that this message could match, best first.
 *
 * The match itself is done in SQL so the whole table never comes back: an exact
 * hit on the message, or a `contains` rule whose keyword occurs in it. Ordering
 * puts exact first, then the operator's `sort_order`, then the oldest rule —
 * three tie-breaks so the answer cannot depend on the plan the planner picked.
 */
export async function findKeywordReplies(db: DbOrTx, message: string): Promise<WechatAutoReply[]> {
  return db
    .select()
    .from(wechatAutoReplies)
    .where(
      and(
        eq(wechatAutoReplies.triggerKind, 'keyword'),
        eq(wechatAutoReplies.isEnabled, true),
        isNull(wechatAutoReplies.deletedAt),
        sql`(
          (${wechatAutoReplies.matchMode} = 'exact' and ${wechatAutoReplies.keyword} = ${message})
          or (${wechatAutoReplies.matchMode} = 'contains' and position(${wechatAutoReplies.keyword} in ${message}) > 0)
        )`,
      ),
    )
    .orderBy(
      sql`case when ${wechatAutoReplies.matchMode} = 'exact' then 0 else 1 end`,
      asc(wechatAutoReplies.sortOrder),
      asc(wechatAutoReplies.id),
    )
    .limit(5);
}

/** Does another live rule already own this keyword? Answers the 409 before the constraint does. */
export async function keywordTaken(
  db: DbOrTx,
  keyword: string,
  exceptId?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: wechatAutoReplies.id })
    .from(wechatAutoReplies)
    .where(
      allOf(
        eq(wechatAutoReplies.triggerKind, 'keyword'),
        eq(wechatAutoReplies.keyword, keyword),
        isNull(wechatAutoReplies.deletedAt),
        exceptId === undefined ? undefined : sql`${wechatAutoReplies.id} <> ${exceptId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function singletonTaken(
  db: DbOrTx,
  triggerKind: 'subscribe' | 'default',
  exceptId?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: wechatAutoReplies.id })
    .from(wechatAutoReplies)
    .where(
      allOf(
        eq(wechatAutoReplies.triggerKind, triggerKind),
        isNull(wechatAutoReplies.deletedAt),
        exceptId === undefined ? undefined : sql`${wechatAutoReplies.id} <> ${exceptId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

export async function listMedia(
  db: DbOrTx,
  filter: { kind?: 'image' | 'voice' | 'video' | 'thumb' | 'news'; offset: number; limit: number },
): Promise<{ rows: WechatMedium[]; total: number }> {
  const where = allOf(filter.kind === undefined ? undefined : eq(wechatMedia.kind, filter.kind));
  const rows = await db
    .select()
    .from(wechatMedia)
    .where(where)
    .orderBy(desc(wechatMedia.id))
    .offset(filter.offset)
    .limit(filter.limit);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(wechatMedia)
    .where(where);
  return { rows, total: count?.total ?? 0 };
}

export async function findMedium(db: DbOrTx, id: number): Promise<WechatMedium | undefined> {
  const rows = await db.select().from(wechatMedia).where(eq(wechatMedia.id, id)).limit(1);
  return rows[0];
}

export type NewMedium = typeof wechatMedia.$inferInsert;

/**
 * Upsert on `(kind, media_id)`.
 *
 * Re-uploading the same attachment gives a *new* handle from WeChat, so this is
 * not the idempotency mechanism — it is what keeps a sync that re-reports a
 * handle we already hold from failing on the unique index.
 */
export async function upsertMedium(db: DbOrTx, values: NewMedium): Promise<WechatMedium> {
  const [row] = await db
    .insert(wechatMedia)
    .values(values)
    .onConflictDoUpdate({
      target: [wechatMedia.kind, wechatMedia.mediaId],
      set: {
        url: sql`excluded.url`,
        attachmentId: sql`excluded.attachment_id`,
        isPermanent: sql`excluded.is_permanent`,
        expiresAt: sql`excluded.expires_at`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

export async function deleteMedium(db: DbOrTx, id: number): Promise<number> {
  const rows = await db.delete(wechatMedia).where(eq(wechatMedia.id, id)).returning({
    id: wechatMedia.id,
  });
  return rows.length;
}

export async function listPermanentMediaIds(
  db: DbOrTx,
  kind: 'image' | 'voice' | 'video' | 'thumb' | 'news',
): Promise<{ id: number; mediaId: string }[]> {
  return db
    .select({ id: wechatMedia.id, mediaId: wechatMedia.mediaId })
    .from(wechatMedia)
    .where(and(eq(wechatMedia.kind, kind), eq(wechatMedia.isPermanent, true)));
}

export async function deleteMediaByIds(db: DbOrTx, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(wechatMedia)
    .where(inArray(wechatMedia.id, [...ids]))
    .returning({ id: wechatMedia.id });
  return rows.length;
}

export async function findAttachment(
  db: DbOrTx,
  id: number,
): Promise<
  | { id: number; storageKey: string; url: string; mime: string; size: number; name: string }
  | undefined
> {
  const rows = await db
    .select({
      id: attachments.id,
      storageKey: attachments.storageKey,
      url: attachments.url,
      mime: attachments.mime,
      size: attachments.size,
      name: attachments.name,
    })
    .from(attachments)
    .where(and(eq(attachments.id, id), isNull(attachments.deletedAt)))
    .limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// QR code categories
// ---------------------------------------------------------------------------

export async function listQrcodeCategories(
  db: DbOrTx,
): Promise<(WechatQrcodeCategory & { qrcodeCount: number })[]> {
  const rows = await db
    .select({
      id: wechatQrcodeCategories.id,
      name: wechatQrcodeCategories.name,
      sortOrder: wechatQrcodeCategories.sortOrder,
      createdAt: wechatQrcodeCategories.createdAt,
      updatedAt: wechatQrcodeCategories.updatedAt,
      deletedAt: wechatQrcodeCategories.deletedAt,
      qrcodeCount: sql<number>`(
        select count(*)::int from ${wechatQrcodes}
        where ${wechatQrcodes.categoryId} = ${wechatQrcodeCategories.id}
          and ${wechatQrcodes.deletedAt} is null
      )`,
    })
    .from(wechatQrcodeCategories)
    .where(isNull(wechatQrcodeCategories.deletedAt))
    .orderBy(asc(wechatQrcodeCategories.sortOrder), asc(wechatQrcodeCategories.id));
  return rows;
}

export async function findQrcodeCategory(
  db: DbOrTx,
  id: number,
): Promise<WechatQrcodeCategory | undefined> {
  const rows = await db
    .select()
    .from(wechatQrcodeCategories)
    .where(and(eq(wechatQrcodeCategories.id, id), isNull(wechatQrcodeCategories.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function insertQrcodeCategory(
  db: DbOrTx,
  values: { name: string; sortOrder: number },
): Promise<WechatQrcodeCategory> {
  const [row] = await db.insert(wechatQrcodeCategories).values(values).returning();
  return row!;
}

export async function updateQrcodeCategory(
  db: DbOrTx,
  id: number,
  patch: { name?: string; sortOrder?: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatQrcodeCategories, {
    where: and(eq(wechatQrcodeCategories.id, id), isNull(wechatQrcodeCategories.deletedAt)),
    set: {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
      updatedAt: patch.now,
    },
  });
}

export async function softDeleteQrcodeCategory(
  db: DbOrTx,
  id: number,
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatQrcodeCategories, {
    where: and(eq(wechatQrcodeCategories.id, id), isNull(wechatQrcodeCategories.deletedAt)),
    set: { deletedAt: now, updatedAt: now },
  });
}

export async function countQrcodesInCategory(db: DbOrTx, categoryId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(wechatQrcodes)
    .where(and(eq(wechatQrcodes.categoryId, categoryId), isNull(wechatQrcodes.deletedAt)));
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// QR codes
// ---------------------------------------------------------------------------

export interface QrcodeRow extends WechatQrcode {
  categoryName: string | null;
}

export interface QrcodeFilter {
  categoryId?: number;
  keyword?: string;
  status?: 'active' | 'disabled';
  sort?: 'createdAt' | 'scanCount' | 'followCount';
  order?: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export async function listQrcodes(
  db: DbOrTx,
  filter: QrcodeFilter,
): Promise<{ rows: QrcodeRow[]; total: number }> {
  const where = allOf(
    isNull(wechatQrcodes.deletedAt),
    filter.categoryId === undefined ? undefined : eq(wechatQrcodes.categoryId, filter.categoryId),
    filter.status === undefined ? undefined : eq(wechatQrcodes.status, filter.status),
    filter.keyword === undefined
      ? undefined
      : ilike(wechatQrcodes.name, containsPattern(filter.keyword)),
  );

  const column =
    filter.sort === 'scanCount'
      ? wechatQrcodes.scanCount
      : filter.sort === 'followCount'
        ? wechatQrcodes.followCount
        : wechatQrcodes.id;
  const direction = filter.order === 'asc' ? asc : desc;

  const rows = await db
    .select({
      id: wechatQrcodes.id,
      categoryId: wechatQrcodes.categoryId,
      categoryName: wechatQrcodeCategories.name,
      name: wechatQrcodes.name,
      scene: wechatQrcodes.scene,
      ticket: wechatQrcodes.ticket,
      imageUrl: wechatQrcodes.imageUrl,
      expiresAt: wechatQrcodes.expiresAt,
      replyType: wechatQrcodes.replyType,
      replyPayload: wechatQrcodes.replyPayload,
      scanCount: wechatQrcodes.scanCount,
      followCount: wechatQrcodes.followCount,
      status: wechatQrcodes.status,
      createdAt: wechatQrcodes.createdAt,
      updatedAt: wechatQrcodes.updatedAt,
      deletedAt: wechatQrcodes.deletedAt,
    })
    .from(wechatQrcodes)
    .leftJoin(wechatQrcodeCategories, eq(wechatQrcodeCategories.id, wechatQrcodes.categoryId))
    .where(where)
    .orderBy(direction(column), desc(wechatQrcodes.id))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(wechatQrcodes)
    .where(where);

  return { rows: rows as QrcodeRow[], total: count?.total ?? 0 };
}

export async function findQrcode(db: DbOrTx, id: number): Promise<QrcodeRow | undefined> {
  const found = await db
    .select({
      id: wechatQrcodes.id,
      categoryId: wechatQrcodes.categoryId,
      categoryName: wechatQrcodeCategories.name,
      name: wechatQrcodes.name,
      scene: wechatQrcodes.scene,
      ticket: wechatQrcodes.ticket,
      imageUrl: wechatQrcodes.imageUrl,
      expiresAt: wechatQrcodes.expiresAt,
      replyType: wechatQrcodes.replyType,
      replyPayload: wechatQrcodes.replyPayload,
      scanCount: wechatQrcodes.scanCount,
      followCount: wechatQrcodes.followCount,
      status: wechatQrcodes.status,
      createdAt: wechatQrcodes.createdAt,
      updatedAt: wechatQrcodes.updatedAt,
      deletedAt: wechatQrcodes.deletedAt,
    })
    .from(wechatQrcodes)
    .leftJoin(wechatQrcodeCategories, eq(wechatQrcodeCategories.id, wechatQrcodes.categoryId))
    .where(and(eq(wechatQrcodes.id, id), isNull(wechatQrcodes.deletedAt)))
    .limit(1);
  return found[0] as QrcodeRow | undefined;
}

/** By scene, for the webhook. Includes disabled codes: a scan still happened. */
export async function findQrcodeByScene(
  db: DbOrTx,
  scene: string,
): Promise<WechatQrcode | undefined> {
  const rows = await db
    .select()
    .from(wechatQrcodes)
    .where(and(eq(wechatQrcodes.scene, scene), isNull(wechatQrcodes.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function sceneTaken(db: DbOrTx, scene: string): Promise<boolean> {
  const rows = await db
    .select({ id: wechatQrcodes.id })
    .from(wechatQrcodes)
    .where(eq(wechatQrcodes.scene, scene))
    .limit(1);
  return rows.length > 0;
}

export type NewQrcode = typeof wechatQrcodes.$inferInsert;

export async function insertQrcode(db: DbOrTx, values: NewQrcode): Promise<WechatQrcode> {
  const [row] = await db.insert(wechatQrcodes).values(values).returning();
  return row!;
}

export async function updateQrcode(
  db: DbOrTx,
  id: number,
  patch: Partial<NewQrcode> & { now: Date },
): Promise<ConditionalUpdateResult> {
  const { now, ...set } = patch;
  return conditionalUpdate(db, wechatQrcodes, {
    where: and(eq(wechatQrcodes.id, id), isNull(wechatQrcodes.deletedAt)),
    set: { ...set, updatedAt: now },
  });
}

export async function softDeleteQrcode(
  db: DbOrTx,
  id: number,
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatQrcodes, {
    where: and(eq(wechatQrcodes.id, id), isNull(wechatQrcodes.deletedAt)),
    set: { deletedAt: now, updatedAt: now },
  });
}

/** `n = n + 1` in the database. Never read-modify-write: scans arrive in parallel. */
export async function bumpQrcodeCounters(
  db: DbOrTx,
  id: number,
  args: { scan: boolean; follow: boolean; now: Date },
): Promise<void> {
  await db
    .update(wechatQrcodes)
    .set({
      ...(args.scan ? { scanCount: sql`${wechatQrcodes.scanCount} + 1` } : {}),
      ...(args.follow ? { followCount: sql`${wechatQrcodes.followCount} + 1` } : {}),
      updatedAt: args.now,
    })
    .where(eq(wechatQrcodes.id, id));
}

export async function insertScan(db: DbOrTx, values: NewWechatQrcodeScan): Promise<void> {
  await db.insert(wechatQrcodeScans).values(values);
}

export interface ScanRow {
  id: number;
  userId: number | null;
  nickname: string | null;
  avatar: string | null;
  openid: string | null;
  isNewFollower: boolean;
  createdAt: Date;
}

export async function listScans(
  db: DbOrTx,
  args: { qrcodeId: number; offset: number; limit: number },
): Promise<{ rows: ScanRow[]; total: number }> {
  const where = eq(wechatQrcodeScans.qrcodeId, args.qrcodeId);
  const rows = await db
    .select({
      id: wechatQrcodeScans.id,
      userId: wechatQrcodeScans.userId,
      nickname: users.nickname,
      avatar: users.avatarUrl,
      openid: wechatQrcodeScans.openid,
      isNewFollower: wechatQrcodeScans.isNewFollower,
      createdAt: wechatQrcodeScans.createdAt,
    })
    .from(wechatQrcodeScans)
    .leftJoin(users, eq(users.id, wechatQrcodeScans.userId))
    .where(where)
    .orderBy(desc(wechatQrcodeScans.id))
    .offset(args.offset)
    .limit(args.limit);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(wechatQrcodeScans)
    .where(where);
  return { rows: rows as ScanRow[], total: count?.total ?? 0 };
}

export interface ScanStatPoint {
  date: string;
  scans: number;
  newFollowers: number;
}

/**
 * Daily buckets in Asia/Shanghai.
 *
 * The timezone is in the SQL rather than in JavaScript because a day boundary
 * computed from the server's `TZ` is a different report on a machine in another
 * region, and this number is read next to WeChat's own, which is Beijing time.
 */
export async function qrcodeStatPoints(
  db: DbOrTx,
  args: { qrcodeId: number; from: Date; to: Date },
): Promise<ScanStatPoint[]> {
  const rows = await db
    .select({
      date: sql<string>`to_char(${wechatQrcodeScans.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      scans: sql<number>`count(*)::int`,
      newFollowers: sql<number>`count(*) filter (where ${wechatQrcodeScans.isNewFollower})::int`,
    })
    .from(wechatQrcodeScans)
    .where(
      and(
        eq(wechatQrcodeScans.qrcodeId, args.qrcodeId),
        gte(wechatQrcodeScans.createdAt, args.from),
        lte(wechatQrcodeScans.createdAt, args.to),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows;
}

export async function countUniqueScanners(db: DbOrTx, qrcodeId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`count(distinct coalesce(${wechatQrcodeScans.openid}, ${wechatQrcodeScans.userId}::text))::int`,
    })
    .from(wechatQrcodeScans)
    .where(eq(wechatQrcodeScans.qrcodeId, qrcodeId));
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// identities — the subscribe/unsubscribe events
// ---------------------------------------------------------------------------

export async function findIdentityByOpenid(
  db: DbOrTx,
  openid: string,
): Promise<{ id: number; userId: number; subscribed: boolean } | undefined> {
  const rows = await db
    .select({
      id: wechatIdentities.id,
      userId: wechatIdentities.userId,
      subscribed: wechatIdentities.subscribed,
    })
    .from(wechatIdentities)
    .where(and(eq(wechatIdentities.platform, 'oa'), eq(wechatIdentities.openid, openid)))
    .limit(1);
  return rows[0];
}

/**
 * Records a follow / unfollow against an identity we already know.
 *
 * It deliberately does **not** create one. An identity is created by the login
 * flow, where the user record and the profile come from; inventing a half-row
 * here would give the shop a customer with no account who cannot be merged with
 * the real one when they eventually log in.
 */
export async function setSubscribed(
  db: DbOrTx,
  args: { openid: string; subscribed: boolean; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatIdentities, {
    where: and(eq(wechatIdentities.platform, 'oa'), eq(wechatIdentities.openid, args.openid)),
    set: {
      subscribed: args.subscribed,
      ...(args.subscribed ? { subscribedAt: args.now } : { unsubscribedAt: args.now }),
      updatedAt: args.now,
    },
  });
}
