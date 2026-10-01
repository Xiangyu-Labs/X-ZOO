import { z } from 'zod';
import { id, instant, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shapes shared by the WeChat Official Account routes.
 *
 * The enums mirror the PostgreSQL enums of `db/src/schema/wechat.ts` and are
 * deliberately *not* imported from `@shop/db` — contracts are the bottom layer.
 * `wechat-oa.service.ts` assigns one to the other and stops compiling if they
 * drift.
 *
 * Two spellings are kept exactly as WeChat writes them, on purpose:
 *
 * - the menu button keys (`sub_button`, `pagepath`, `appid`) — the tree is
 *   POSTed to `cgi-bin/menu/create` verbatim, and a camelCase layer here would
 *   be one more place to get the translation wrong;
 * - the media kinds (`image`, `voice`, `video`, `thumb`, `news`), which are
 *   WeChat's own `type` parameter.
 *
 * Everything else is camelCase like the rest of the system.
 */

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

/**
 * One button of the OA bottom menu.
 *
 * Recursive, so it is declared with an explicit output type: `zod-to-openapi`
 * overflows the stack on a `z.lazy` tree that has no named ref, and the admin
 * editor wants the whole tree in one payload anyway (three buttons, five
 * children each — it is never big).
 */
export interface WechatMenuButtonShape {
  name: string;
  type?: 'view' | 'click' | 'miniprogram' | undefined;
  key?: string | undefined;
  url?: string | undefined;
  appid?: string | undefined;
  pagepath?: string | undefined;
  sub_button?: WechatMenuButtonShape[] | undefined;
}

export const wechatMenuButtonType = z.enum(['view', 'click', 'miniprogram']);
export type WechatMenuButtonType = z.infer<typeof wechatMenuButtonType>;

const leafButton = z.object({
  name: z.string().min(1).max(60),
  type: wechatMenuButtonType.optional(),
  /** `click` buttons only; matched against a keyword auto-reply. */
  key: z.string().max(128).optional(),
  /** `view` buttons only. */
  url: z.string().max(1024).optional(),
  /** `miniprogram` buttons only. */
  appid: z.string().max(64).optional(),
  pagepath: z.string().max(256).optional(),
});

export const wechatMenuButton: z.ZodType<WechatMenuButtonShape> = leafButton.extend({
  /**
   * A parent button carries children and no action of its own. WeChat allows
   * at most 5 children; the service checks the whole tree with
   * `validateMenuTree` and refuses with `WECHAT_OA_MENU_INVALID`.
   */
  sub_button: z.array(leafButton).max(5).optional(),
});

export const wechatMenu = z.object({
  id,
  name: z.string(),
  buttons: z.array(wechatMenuButton),
  isActive: z.boolean(),
  publishedAt: instant.nullable(),
  /**
   * WeChat's refusal of the last publish as it came back (errcode, errmsg), for
   * whoever debugs it. Staff-only and shown only under 技术详情: the screen
   * shows `publishErrorSummary`.
   */
  publishError: z.string().nullable(),
  /** The same refusal in Chinese, what staff read. Non-null exactly when `publishError` is. */
  publishErrorSummary: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
});
export type WechatMenu = z.infer<typeof wechatMenu>;

export const wechatMenuForm = z.object({
  name: z.string().min(1).max(100),
  /** WeChat allows at most 3 top-level buttons. */
  buttons: z.array(wechatMenuButton).min(1).max(3),
});
export type WechatMenuForm = z.infer<typeof wechatMenuForm>;

export const pagedWechatMenus = paged(wechatMenu);

export const wechatMenuExample = {
  id: '1',
  name: '默认菜单',
  buttons: [
    {
      name: '商城',
      sub_button: [
        { name: '首页', type: 'view', url: 'https://shop.example.com/' },
        { name: '我的订单', type: 'view', url: 'https://shop.example.com/orders' },
      ],
    },
    { name: '联系客服', type: 'click', key: 'CONTACT' },
  ],
  isActive: true,
  publishedAt: '2026-01-04T10:30:00+08:00',
  publishError: null,
  publishErrorSummary: null,
  createdAt: '2026-01-04T10:00:00+08:00',
  updatedAt: '2026-01-04T10:30:00+08:00',
} satisfies z.input<typeof wechatMenu>;

// ---------------------------------------------------------------------------
// auto replies
// ---------------------------------------------------------------------------

export const wechatReplyTrigger = z.enum(['subscribe', 'keyword', 'default']);
export type WechatReplyTrigger = z.infer<typeof wechatReplyTrigger>;

export const wechatReplyMatchMode = z.enum(['exact', 'contains']);
export type WechatReplyMatchMode = z.infer<typeof wechatReplyMatchMode>;

export const wechatReplyType = z.enum(['text', 'image', 'voice', 'video', 'news']);
export type WechatReplyType = z.infer<typeof wechatReplyType>;

/** One article of a `news` reply. WeChat renders at most 8. */
export const wechatReplyArticle = z.object({
  title: z.string().min(1).max(128),
  description: z.string().max(512).default(''),
  url: z.string().max(1024),
  picUrl: z.string().max(1024).default(''),
});
export type WechatReplyArticle = z.infer<typeof wechatReplyArticle>;

/**
 * The reply body, discriminated by `replyType`.
 *
 * One object with every field optional would have been less code and much
 * worse: "a news reply with no articles" would then be a valid request that
 * produces an empty bubble in the user's chat. The refinement below makes the
 * shape that cannot be rendered un-submittable.
 */
export const wechatReplyPayload = z
  .object({
    /** `text` */
    text: z.string().max(2048).optional(),
    /** `image` / `voice` / `video` — WeChat's own media handle. */
    mediaId: z.string().max(128).optional(),
    /** Rendered preview for the admin list; never sent to WeChat. */
    url: z.string().max(1024).optional(),
    /** `video` only. */
    title: z.string().max(128).optional(),
    description: z.string().max(512).optional(),
    /** `news` */
    articles: z.array(wechatReplyArticle).max(8).optional(),
  })
  .strict();
export type WechatReplyPayload = z.infer<typeof wechatReplyPayload>;

export const wechatAutoReply = z.object({
  id,
  triggerKind: wechatReplyTrigger,
  keyword: z.string().nullable(),
  matchMode: wechatReplyMatchMode.nullable(),
  replyType: wechatReplyType,
  payload: wechatReplyPayload,
  isEnabled: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: instant,
  updatedAt: instant,
});
export type WechatAutoReply = z.infer<typeof wechatAutoReply>;

export const wechatAutoReplyForm = z
  .object({
    triggerKind: wechatReplyTrigger,
    /** Required for `keyword`, forbidden otherwise — `wechat_auto_replies_keyword_shape`. */
    keyword: z.string().min(1).max(64).optional(),
    matchMode: wechatReplyMatchMode.optional(),
    replyType: wechatReplyType.default('text'),
    payload: wechatReplyPayload,
    isEnabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .refine((v) => (v.triggerKind === 'keyword') === (v.keyword !== undefined), {
    message: '关键词回复必须填写关键词，其他类型不能填写',
    path: ['keyword'],
  });
export type WechatAutoReplyForm = z.infer<typeof wechatAutoReplyForm>;

export const wechatAutoReplyListQuery = pageQuery.extend({
  triggerKind: wechatReplyTrigger.optional(),
  keyword: z.string().trim().max(64).optional(),
  isEnabled: z.stringbool().optional(),
});
export type WechatAutoReplyListQuery = z.infer<typeof wechatAutoReplyListQuery>;

export const pagedWechatAutoReplies = paged(wechatAutoReply);

export const wechatAutoReplyExample = {
  id: '1',
  triggerKind: 'keyword',
  keyword: '优惠券',
  matchMode: 'contains',
  replyType: 'text',
  payload: { text: '点击 https://shop.example.com/coupons 领取本月优惠券' },
  isEnabled: true,
  sortOrder: 0,
  createdAt: '2026-01-04T10:00:00+08:00',
  updatedAt: '2026-01-04T10:00:00+08:00',
} satisfies z.input<typeof wechatAutoReply>;

/**
 * 回复模拟: what the account would say to a message, a menu click or a new
 * follower, asked of the same lookup the live webhook uses.
 */
export const wechatReplySimulateBody = z.object({
  kind: z.enum(['text', 'click', 'subscribe']),
  /** The message, or the menu button's key for `click`. Ignored for `subscribe`. */
  text: z.string().max(2048).default(''),
});
export type WechatReplySimulateBody = z.infer<typeof wechatReplySimulateBody>;

export const wechatReplySimulateResult = z.object({
  /** Which rule answered: a keyword rule, one of the two singletons, or nothing. */
  source: z.enum(['keyword', 'subscribe', 'default', 'none']),
  reply: wechatAutoReply.nullable(),
  /** Keyword rules that also matched but lost on priority. */
  shadowed: z.array(wechatAutoReply),
  explanation: z.string(),
});
export type WechatReplySimulateResult = z.infer<typeof wechatReplySimulateResult>;

export const wechatStatusBody = z.object({ isEnabled: z.boolean() });
export type WechatStatusBody = z.infer<typeof wechatStatusBody>;

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

export const wechatMediaKind = z.enum(['image', 'voice', 'video', 'thumb', 'news']);
export type WechatMediaKind = z.infer<typeof wechatMediaKind>;

export const wechatMedium = z.object({
  id,
  kind: wechatMediaKind,
  mediaId: z.string(),
  attachmentId: id.nullable(),
  url: z.string().nullable(),
  isPermanent: z.boolean(),
  expiresAt: instant.nullable(),
  createdAt: instant,
});
export type WechatMedium = z.infer<typeof wechatMedium>;

export const wechatMediaListQuery = pageQuery.extend({
  kind: wechatMediaKind.optional(),
});
export type WechatMediaListQuery = z.infer<typeof wechatMediaListQuery>;

export const pagedWechatMedia = paged(wechatMedium);

/**
 * Upload takes an **attachment id**, never a file.
 *
 * The attachment library already has the file; re-uploading the bytes through a
 * second multipart endpoint would give us two copies and two places to get the
 * MIME check wrong. `POST /admin-api/wechat-media` pushes an attachment we
 * already hold to WeChat and records the handle.
 */
export const wechatMediaUploadBody = z.object({
  attachmentId: id,
  kind: wechatMediaKind.default('image'),
  /** `false` produces a three-day temporary asset — cheaper, and enough for a reply. */
  isPermanent: z.boolean().default(true),
});
export type WechatMediaUploadBody = z.infer<typeof wechatMediaUploadBody>;

export const wechatMediaSyncResult = z.object({
  /** Rows whose WeChat handle no longer exists and were removed. */
  removed: z.number().int().min(0),
  /** Rows WeChat knows about that we did not, now recorded. */
  added: z.number().int().min(0),
  /** Rows already in step. */
  unchanged: z.number().int().min(0),
});
export type WechatMediaSyncResult = z.infer<typeof wechatMediaSyncResult>;

export const wechatMediumExample = {
  id: '1',
  kind: 'image',
  mediaId: 'MEDIA_ID_0001',
  attachmentId: '12',
  url: 'https://shop.example.com/uploads/2026/01/banner.png',
  isPermanent: true,
  expiresAt: null,
  createdAt: '2026-01-04T10:00:00+08:00',
} satisfies z.input<typeof wechatMedium>;

// ---------------------------------------------------------------------------
// channel QR codes
// ---------------------------------------------------------------------------

export const wechatQrcodeStatus = z.enum(['active', 'disabled']);
export type WechatQrcodeStatus = z.infer<typeof wechatQrcodeStatus>;

export const wechatQrcodeCategory = z.object({
  id,
  name: z.string(),
  sortOrder: z.number().int(),
  /** How many live QR codes are filed here. The delete button is disabled when it is not 0. */
  qrcodeCount: z.number().int().min(0),
  createdAt: instant,
});
export type WechatQrcodeCategory = z.infer<typeof wechatQrcodeCategory>;

export const wechatQrcodeCategoryForm = z.object({
  name: z.string().min(1).max(64),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type WechatQrcodeCategoryForm = z.infer<typeof wechatQrcodeCategoryForm>;

export const wechatQrcode = z.object({
  id,
  categoryId: id.nullable(),
  categoryName: z.string().nullable(),
  name: z.string(),
  scene: z.string(),
  ticket: z.string().nullable(),
  imageUrl: z.string().nullable(),
  /** `null` = permanent. */
  expiresAt: instant.nullable(),
  replyType: wechatReplyType.nullable(),
  replyPayload: wechatReplyPayload.nullable(),
  scanCount: z.number().int().min(0),
  followCount: z.number().int().min(0),
  status: wechatQrcodeStatus,
  createdAt: instant,
  updatedAt: instant,
});
export type WechatQrcode = z.infer<typeof wechatQrcode>;

export const wechatQrcodeForm = z.object({
  name: z.string().min(1).max(100),
  categoryId: id.optional(),
  /**
   * Left out, the service generates one. Supplied, it must be unique —
   * `WECHAT_OA_QRCODE_SCENE_TAKEN`, because the scene string is the only thing
   * that attributes a scan to a channel.
   */
  scene: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, '场景值只能包含字母、数字、下划线和短横线')
    .optional(),
  /**
   * `0` (the default) asks WeChat for a permanent QR code. Anything else asks
   * for a temporary one that expires after that many seconds, capped at 30 days
   * — WeChat's own limit, enforced here so the failure is a 422 and not a 502.
   */
  expireSeconds: z.number().int().min(0).max(2_592_000).default(0),
  replyType: wechatReplyType.optional(),
  replyPayload: wechatReplyPayload.optional(),
});
export type WechatQrcodeForm = z.infer<typeof wechatQrcodeForm>;

export const wechatQrcodeListQuery = pageQuery
  .extend({
    categoryId: id.optional(),
    keyword: z.string().trim().max(64).optional(),
    status: wechatQrcodeStatus.optional(),
  })
  .extend(sortQuery(['createdAt', 'scanCount', 'followCount']).shape);
export type WechatQrcodeListQuery = z.infer<typeof wechatQrcodeListQuery>;

export const pagedWechatQrcodes = paged(wechatQrcode);

export const wechatQrcodeStatusBody = z.object({ status: wechatQrcodeStatus });
export type WechatQrcodeStatusBody = z.infer<typeof wechatQrcodeStatusBody>;

/** One day of a channel code's scan history. */
export const wechatQrcodeStatPoint = z.object({
  /** `YYYY-MM-DD` in Asia/Shanghai, which is the only timezone a Chinese shop reports in. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scans: z.number().int().min(0),
  newFollowers: z.number().int().min(0),
});
export type WechatQrcodeStatPoint = z.infer<typeof wechatQrcodeStatPoint>;

export const wechatQrcodeStatistic = z.object({
  qrcodeId: id,
  name: z.string(),
  scanCount: z.number().int().min(0),
  followCount: z.number().int().min(0),
  /** Distinct openids, which is a different and more useful number than `scanCount`. */
  uniqueScanners: z.number().int().min(0),
  points: z.array(wechatQrcodeStatPoint),
});
export type WechatQrcodeStatistic = z.infer<typeof wechatQrcodeStatistic>;

export const wechatQrcodeStatQuery = z.object({
  /** Inclusive, `YYYY-MM-DD`. Defaults to the last 30 days. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type WechatQrcodeStatQuery = z.infer<typeof wechatQrcodeStatQuery>;

export const wechatQrcodeScan = z.object({
  id,
  userId: id.nullable(),
  nickname: z.string().nullable(),
  avatar: z.string().nullable(),
  /** Masked to the first and last four characters: it identifies a person. */
  openid: z.string().nullable(),
  isNewFollower: z.boolean(),
  createdAt: instant,
});
export type WechatQrcodeScan = z.infer<typeof wechatQrcodeScan>;

export const pagedWechatQrcodeScans = paged(wechatQrcodeScan);

export const wechatQrcodeExample = {
  id: '1',
  categoryId: '1',
  categoryName: '线下门店',
  name: '朝阳门店海报',
  scene: 'CH_A1B2C3',
  ticket: 'gQH7...==',
  imageUrl: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=gQH7...%3D%3D',
  expiresAt: null,
  replyType: 'text',
  replyPayload: { text: '欢迎关注，回复「优惠券」领取新人券' },
  scanCount: 128,
  followCount: 47,
  status: 'active',
  createdAt: '2026-01-04T10:00:00+08:00',
  updatedAt: '2026-01-06T09:00:00+08:00',
} satisfies z.input<typeof wechatQrcode>;

export const wechatQrcodeCategoryExample = {
  id: '1',
  name: '线下门店',
  sortOrder: 0,
  qrcodeCount: 3,
  createdAt: '2026-01-04T10:00:00+08:00',
} satisfies z.input<typeof wechatQrcodeCategory>;

// ---------------------------------------------------------------------------
// storefront: JS-SDK and subscribe templates
// ---------------------------------------------------------------------------

export const jssdkConfigQuery = z.object({
  /**
   * The page URL to sign, **including** the query string and **excluding** the
   * `#` fragment. WeChat signs exactly the string the page reports as
   * `location.href.split('#')[0]`, so anything else produces
   * `invalid signature` in the browser with no server-side symptom at all.
   */
  url: z.string().min(1).max(1024),
});
export type JssdkConfigQuery = z.infer<typeof jssdkConfigQuery>;

/**
 * The `wx.config` argument, with WeChat's own key spelling.
 *
 * `appId`, `timestamp`, `nonceStr` and `signature` go to `wx.config` verbatim,
 * so they keep WeChat's names for the same reason the JSAPI pay parameters do.
 */
export const jssdkConfig = z.object({
  appId: z.string(),
  /** Seconds, as a string: WeChat signs the string, and a JS number loses nothing but invites rounding. */
  timestamp: z.string(),
  nonceStr: z.string(),
  signature: z.string(),
});
export type JssdkConfig = z.infer<typeof jssdkConfig>;

/**
 * Subscribe-message template ids for one scene.
 *
 * The mini-program has to ask the user's permission *before* it may send, and
 * `wx.requestSubscribeMessage` takes template ids — so the client asks us which
 * ids a given moment needs. The scene names are ours, not WeChat's.
 */
export const subscribeScene = z.enum([
  'order-create',
  'order-pay',
  'order-unpaid',
  'order-ship',
  'refund',
]);
export type SubscribeScene = z.infer<typeof subscribeScene>;

export const subscribeTemplatesQuery = z.object({ scene: subscribeScene });
export type SubscribeTemplatesQuery = z.infer<typeof subscribeTemplatesQuery>;

export const subscribeTemplates = z.object({
  /** Empty when the shop has configured no subscribe templates: the client then skips the prompt. */
  templateIds: z.array(z.string()),
});
export type SubscribeTemplates = z.infer<typeof subscribeTemplates>;
