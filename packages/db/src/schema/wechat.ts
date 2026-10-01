import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, emptyJsonObject, fk, instant, pk, updatedAt } from './_shared';
import { attachments } from './storage';
import { users } from './user';

/**
 * WeChat: the identities a customer signs in with, and the Official Account
 * assets an operator manages (menu, auto-replies, channel QR codes, media).
 *
 * An identity is an identity: the profile lives on `users` and this table only
 * holds what WeChat owns, one row per (platform, openid).
 */

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

export const wechatIdentitiesPlatform = pgEnum('wechat_identities_platform', ['oa', 'mini']);

export const wechatIdentities = pgTable(
  'wechat_identities',
  {
    id: pk(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: wechatIdentitiesPlatform().notNull(),
    /** Unique per app, which is why the unique key is `(platform, openid)` and not `openid` alone. */
    openid: varchar({ length: 64 }).notNull(),
    /** Present only once the app is bound to an Open Platform account. Ties `oa` and `mini` together. */
    unionid: varchar({ length: 64 }),
    /** Profile as WeChat last reported it. The canonical values live on `users`. */
    nickname: varchar({ length: 64 }),
    avatarUrl: varchar({ length: 512 }),
    /** `oa` only. */
    subscribed: boolean().notNull().default(false),
    subscribedAt: instant(),
    unsubscribedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('wechat_identities_openid_uq').on(t.platform, t.openid),
    uniqueIndex('wechat_identities_user_platform_uq').on(t.userId, t.platform),
    index('wechat_identities_unionid_idx').on(t.unionid),
  ],
);

export type WechatIdentity = typeof wechatIdentities.$inferSelect;
export type NewWechatIdentity = typeof wechatIdentities.$inferInsert;

// ---------------------------------------------------------------------------
// official account menu
// ---------------------------------------------------------------------------

/** One button of the OA bottom menu. */
export interface WechatMenuButton {
  name: string;
  type?: 'view' | 'click' | 'miniprogram';
  key?: string;
  url?: string;
  appid?: string;
  pagepath?: string;
  sub_button?: WechatMenuButton[];
}

/**
 * Versions of the Official Account menu, so "what did we publish last week" is
 * answerable.
 */
export const wechatOaMenus = pgTable(
  'wechat_oa_menus',
  {
    id: pk(),
    name: varchar({ length: 100 }).notNull(),
    buttons: jsonb().$type<WechatMenuButton[]>().notNull(),
    isActive: boolean().notNull().default(false),
    /** Set once WeChat has accepted the menu. */
    publishedAt: instant(),
    /** WeChat's refusal as it came back (errcode, errmsg): staff see it only under 技术详情. */
    publishError: varchar({ length: 255 }),
    /**
     * The same refusal in Chinese for staff, written with `publish_error`.
     * `null` on rows from before it was written; the screen then shows a generic line.
     */
    publishErrorSummary: varchar({ length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('wechat_oa_menus_active_uq')
      .on(t.isActive)
      .where(sql`is_active and deleted_at is null`),
  ],
);

export type WechatOaMenu = typeof wechatOaMenus.$inferSelect;
export type NewWechatOaMenu = typeof wechatOaMenus.$inferInsert;

// ---------------------------------------------------------------------------
// auto replies
// ---------------------------------------------------------------------------

export const wechatAutoRepliesTrigger = pgEnum('wechat_auto_replies_trigger', [
  'subscribe',
  'keyword',
  'default',
]);

export const wechatAutoRepliesMatchMode = pgEnum('wechat_auto_replies_match_mode', [
  'exact',
  'contains',
]);

export const wechatAutoRepliesReplyType = pgEnum('wechat_auto_replies_reply_type', [
  'text',
  'image',
  'voice',
  'video',
  'news',
]);

export const wechatAutoReplies = pgTable(
  'wechat_auto_replies',
  {
    id: pk(),
    triggerKind: wechatAutoRepliesTrigger().notNull(),
    /** `keyword` trigger only. */
    keyword: varchar({ length: 64 }),
    matchMode: wechatAutoRepliesMatchMode(),
    replyType: wechatAutoRepliesReplyType().notNull().default('text'),
    /** Shape depends on `replyType`: `{ text }`, `{ mediaId, url }`, `{ articles: [...] }`. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
    isEnabled: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // At most one subscribe reply and one fallback reply.
    uniqueIndex('wechat_auto_replies_singleton_uq')
      .on(t.triggerKind)
      .where(sql`trigger_kind in ('subscribe','default') and deleted_at is null`),
    uniqueIndex('wechat_auto_replies_keyword_uq')
      .on(t.keyword)
      .where(sql`trigger_kind = 'keyword' and deleted_at is null`),
    check(
      'wechat_auto_replies_keyword_shape',
      sql`(${t.triggerKind} = 'keyword') = (${t.keyword} is not null and ${t.matchMode} is not null)`,
    ),
  ],
);

export type WechatAutoReply = typeof wechatAutoReplies.$inferSelect;
export type NewWechatAutoReply = typeof wechatAutoReplies.$inferInsert;

// ---------------------------------------------------------------------------
// channel QR codes
// ---------------------------------------------------------------------------

export const wechatQrcodeCategories = pgTable(
  'wechat_qrcode_categories',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // Scoped to the live rows. Unscoped, a deleted folder held its name for
    // ever: 渠道二维码分类 is a short list of short words, an operator deletes 双十一 and
    // cannot create it again next year, and the 409 says the name is taken
    // while the screen shows nothing of the sort. Both soft-deleting siblings
    // above are scoped the same way.
    uniqueIndex('wechat_qrcode_categories_name_uq')
      .on(t.name)
      .where(sql`deleted_at is null`),
  ],
);

export type WechatQrcodeCategory = typeof wechatQrcodeCategories.$inferSelect;
export type NewWechatQrcodeCategory = typeof wechatQrcodeCategories.$inferInsert;

export const wechatQrcodesStatus = pgEnum('wechat_qrcodes_status', ['active', 'disabled']);

export const wechatQrcodes = pgTable(
  'wechat_qrcodes',
  {
    id: pk(),
    categoryId: fk().references(() => wechatQrcodeCategories.id, { onDelete: 'set null' }),
    name: varchar({ length: 100 }).notNull(),
    /** The scene string WeChat echoes back on scan. Unique because it is how a scan is attributed. */
    scene: varchar({ length: 64 }).notNull(),
    ticket: text(),
    imageUrl: varchar({ length: 512 }),
    /** NULL = permanent QR code. */
    expiresAt: instant(),
    /** Reply sent to whoever scans, same shape rules as `wechat_auto_replies.payload`. */
    replyType: wechatAutoRepliesReplyType(),
    replyPayload: jsonb().$type<Record<string, unknown>>(),
    scanCount: integer().notNull().default(0),
    followCount: integer().notNull().default(0),
    status: wechatQrcodesStatus().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('wechat_qrcodes_scene_uq').on(t.scene),
    index('wechat_qrcodes_category_idx').on(t.categoryId),
    check(
      'wechat_qrcodes_counters_non_negative',
      sql`${t.scanCount} >= 0 and ${t.followCount} >= 0`,
    ),
  ],
);

export type WechatQrcode = typeof wechatQrcodes.$inferSelect;
export type NewWechatQrcode = typeof wechatQrcodes.$inferInsert;

export const wechatQrcodeScans = pgTable(
  'wechat_qrcode_scans',
  {
    id: pk(),
    qrcodeId: fk()
      .notNull()
      .references(() => wechatQrcodes.id, { onDelete: 'cascade' }),
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    /** Recorded even when the scanner has no account yet. */
    openid: varchar({ length: 64 }),
    /** TRUE when the scan produced a new subscriber rather than an existing one. */
    isNewFollower: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('wechat_qrcode_scans_qrcode_idx').on(t.qrcodeId, t.createdAt),
    index('wechat_qrcode_scans_user_idx').on(t.userId),
  ],
);

export type WechatQrcodeScan = typeof wechatQrcodeScans.$inferSelect;
export type NewWechatQrcodeScan = typeof wechatQrcodeScans.$inferInsert;

// ---------------------------------------------------------------------------
// mini-program codes
// ---------------------------------------------------------------------------

/**
 * Generated 小程序码 (`wxa/getwxacodeunlimit`), one row per `(page, scene)`.
 *
 * A cache, not an asset library: the PNG is identical for a given pair, the
 * call costs a WeChat quota, and the storefront asks for the same code every
 * time a shopper opens a share sheet. The table is what makes the second ask
 * free — the bytes go through the storage driver like any other generated
 * artefact and only the key and the public URL are kept here.
 *
 * Deliberately not `attachments`: nobody browses these in the media library,
 * and putting them there would bury the operator's own images under one row
 * per product per poster.
 *
 * There is no `deleted_at`. Dropping a row is how the code is regenerated, and
 * a soft delete would only mean the unique index had to be scoped for no
 * reason anybody can act on.
 */
export const wechatMiniCodes = pgTable(
  'wechat_mini_codes',
  {
    id: pk(),
    /** Mini-program page path, from the contract's allow-list. */
    page: varchar({ length: 128 }).notNull(),
    /** WeChat's own cap is 32 **bytes**, which the service checks before this. */
    scene: varchar({ length: 32 }).notNull(),
    /** Storage key the PNG was written to. */
    storageKey: varchar({ length: 512 }).notNull(),
    /** Public URL at the time of generation; site-relative for the local driver. */
    url: varchar({ length: 1024 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('wechat_mini_codes_page_scene_uq').on(t.page, t.scene)],
);

export type WechatMiniCode = typeof wechatMiniCodes.$inferSelect;
export type NewWechatMiniCode = typeof wechatMiniCodes.$inferInsert;

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

export const wechatMediaKind = pgEnum('wechat_media_kind', [
  'image',
  'voice',
  'video',
  'thumb',
  'news',
]);

/** Assets uploaded to WeChat, mapped back to the local media library. */
export const wechatMedia = pgTable(
  'wechat_media',
  {
    id: pk(),
    kind: wechatMediaKind().notNull(),
    /** WeChat's own handle. */
    mediaId: varchar({ length: 128 }).notNull(),
    attachmentId: fk().references(() => attachments.id, { onDelete: 'set null' }),
    url: text(),
    /** FALSE = temporary asset, expires after three days. */
    isPermanent: boolean().notNull().default(true),
    expiresAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('wechat_media_uq').on(t.kind, t.mediaId),
    index('wechat_media_attachment_idx').on(t.attachmentId),
    check('wechat_media_temporary_expires', sql`${t.isPermanent} or ${t.expiresAt} is not null`),
  ],
);

export type WechatMedium = typeof wechatMedia.$inferSelect;
export type NewWechatMedium = typeof wechatMedia.$inferInsert;

// ---------------------------------------------------------------------------
// 内容安全 (mini-program mediaCheckAsync)
// ---------------------------------------------------------------------------

/** What a checked picture belongs to. The owning domain acts on a `risky` verdict. */
export const contentSecurityChecksSubject = pgEnum('content_security_checks_subject', [
  'review_image',
  'avatar',
]);

/**
 * `pending` — recorded, not yet handed to WeChat; `submitted` — WeChat has it
 * and owes a `wxa_media_check` push; `pass` / `review` / `risky` — WeChat's
 * verdict; `skipped` — never sent (no mini-program openid, no public HTTPS
 * address, or 内容安全 switched off).
 */
export const contentSecurityChecksStatus = pgEnum('content_security_checks_status', [
  'pending',
  'submitted',
  'pass',
  'review',
  'risky',
  'skipped',
]);

/**
 * One picture sent to `mediaCheckAsync`, and what came of it (C09).
 *
 * The verdict arrives later, by push, carrying only WeChat's `trace_id`: this
 * table is how a `trace_id` finds the review or the avatar it is about. It is
 * also the record of what was hidden and why — a picture taken off a review is
 * removed from `product_reviews.images`, and its address stays here.
 */
export const contentSecurityChecks = pgTable(
  'content_security_checks',
  {
    id: pk(),
    subject: contentSecurityChecksSubject().notNull(),
    /** `product_reviews.id` or `users.id`, by `subject`. Not a foreign key: two tables. */
    subjectId: fk().notNull(),
    /** Whose openid the check is made under. */
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    mediaUrl: varchar({ length: 1024 }).notNull(),
    /** WeChat's `scene`: 1 资料, 2 评论. */
    scene: smallint().notNull(),
    status: contentSecurityChecksStatus().notNull().default('pending'),
    traceId: varchar({ length: 64 }),
    /** WeChat's `label` on a verdict (e.g. 20002 色情). */
    label: integer(),
    /** What the owning domain did about a `risky` verdict: `image_hidden`, `avatar_reset`, `none`. */
    action: varchar({ length: 32 }),
    submittedAt: instant(),
    resolvedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('content_security_checks_trace_uq')
      .on(t.traceId)
      .where(sql`trace_id is not null`),
    index('content_security_checks_subject_idx').on(t.subject, t.subjectId),
    check(
      'content_security_checks_verdict_shape',
      sql`${t.status} not in ('pass','review','risky') or ${t.resolvedAt} is not null`,
    ),
  ],
);

export type ContentSecurityCheck = typeof contentSecurityChecks.$inferSelect;
export type NewContentSecurityCheck = typeof contentSecurityChecks.$inferInsert;
