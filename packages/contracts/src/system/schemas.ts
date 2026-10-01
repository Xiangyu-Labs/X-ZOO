import { z } from 'zod';
import { id, instant, newPassword, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shapes shared by the `system` routes: admins, roles, the permission tree, the
 * audit log, agreements, typed config groups and the dashboard header.
 *
 * Contracts are the bottom layer, so nothing here imports `@shop/db` or
 * `@shop/core`. Where a shape mirrors something declared in code — the config
 * field kinds mirror `ConfigFieldUi['type']` in `core/kernel/config-registry.ts`
 * and `ConfigFieldKind` in the admin kit — `system.config.service.ts` assigns one
 * to the other and stops compiling if they drift.
 */

// ---------------------------------------------------------------------------
// admins
// ---------------------------------------------------------------------------

/** `admins.status`: 1 enabled, 0 disabled. A boolean on the wire, per `docs/conventions.md`. */
export const adminListItem = z.object({
  id,
  account: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
  phone: z.string().nullable(),
  isSuper: z.boolean(),
  enabled: z.boolean(),
  roleIds: z.array(id),
  roleNames: z.array(z.string()),
  lastLoginAt: instant.nullable(),
  createdAt: instant,
});
export type AdminListItem = z.infer<typeof adminListItem>;

export const adminListItemExample: AdminListItem = {
  id: '1',
  account: 'admin',
  name: '超级管理员',
  avatar: null,
  phone: '13800000000',
  isSuper: true,
  enabled: true,
  roleIds: [],
  roleNames: [],
  lastLoginAt: '2026-09-21T10:00:00+08:00',
  createdAt: '2026-01-01T00:00:00+08:00',
};

export const adminListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    enabled: z.stringbool().optional(),
    roleId: id.optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'lastLoginAt']).shape);
export type AdminListQuery = z.infer<typeof adminListQuery>;

export const pagedAdmins = paged(adminListItem);

/**
 * Create and edit share one body. `password` is required on create and optional
 * on edit (absent = unchanged); the service, not the schema, enforces that,
 * because the same form serves both and a single schema keeps `ModalForm` honest.
 */
export const adminForm = z.object({
  account: z
    .string()
    .trim()
    .min(3, '账号至少 3 个字符')
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, '账号只能包含字母、数字、下划线、点和横线'),
  name: z.string().trim().min(1, '请填写姓名').max(64),
  password: newPassword(8, '密码至少 8 位').optional(),
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/, '手机号格式不正确')
    .nullable()
    .optional(),
  avatar: z.string().max(512).nullable().optional(),
  enabled: z.boolean().default(true),
  roleIds: z.array(id).max(20).default([]),
});
export type AdminForm = z.infer<typeof adminForm>;

export const adminStatusBody = z.object({ enabled: z.boolean() });
export type AdminStatusBody = z.infer<typeof adminStatusBody>;

/** An operator resetting somebody else's password. Their sessions all die. */
export const adminPasswordBody = z.object({
  password: newPassword(8, '密码至少 8 位'),
});
export type AdminPasswordBody = z.infer<typeof adminPasswordBody>;

export const adminMutationResult = z.object({
  admin: adminListItem,
  /** How many live sessions the change destroyed. `0` for a plain edit. */
  revokedSessions: z.number().int().min(0),
});
export type AdminMutationResult = z.infer<typeof adminMutationResult>;

// ---------------------------------------------------------------------------
// own profile
// ---------------------------------------------------------------------------

export const adminSelfProfile = z.object({
  id,
  account: z.string(),
  name: z.string(),
  avatar: z.string().nullable(),
  phone: z.string().nullable(),
  isSuper: z.boolean(),
  roleNames: z.array(z.string()),
  permissions: z.array(z.string()),
  lastLoginAt: instant.nullable(),
});
export type AdminSelfProfile = z.infer<typeof adminSelfProfile>;

export const adminSelfProfileExample: AdminSelfProfile = {
  id: '1',
  account: 'admin',
  name: '超级管理员',
  avatar: null,
  phone: '13800000000',
  isSuper: true,
  roleNames: [],
  permissions: [
    'auth:profile:read',
    'auth:profile:update',
    'auth:session:delete',
    'auth:session:read',
  ],
  lastLoginAt: '2026-09-21T10:00:00+08:00',
};

export const profileForm = z.object({
  name: z.string().trim().min(1, '请填写姓名').max(64),
  avatar: z.string().max(512).nullable().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/, '手机号格式不正确')
    .nullable()
    .optional(),
});
export type ProfileForm = z.infer<typeof profileForm>;

/**
 * Changing one's own password. The current one is required — a stolen cookie
 * must not be enough to lock the real owner out — and success revokes every
 * session, including the caller's.
 */
export const profilePasswordBody = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码').max(128),
    newPassword: newPassword(8, '新密码至少 8 位'),
    confirmPassword: newPassword(8),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: '两次输入的新密码不一致',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: '新密码不能和当前密码相同',
    path: ['newPassword'],
  });
export type ProfilePasswordBody = z.infer<typeof profilePasswordBody>;

export const passwordChangeResult = z.object({
  revokedSessions: z.number().int().min(0),
});
export type PasswordChangeResult = z.infer<typeof passwordChangeResult>;

// ---------------------------------------------------------------------------
// roles and the permission tree
// ---------------------------------------------------------------------------

export const roleListItem = z.object({
  id,
  name: z.string(),
  remark: z.string().nullable(),
  enabled: z.boolean(),
  /** How many admins hold this role. Deleting a role in use is refused. */
  adminCount: z.number().int().min(0),
  permissionCount: z.number().int().min(0),
  createdAt: instant,
});
export type RoleListItem = z.infer<typeof roleListItem>;

export const roleDetail = roleListItem.extend({
  /**
   * The atoms stored for this role, including any the code no longer declares —
   * a retired atom grants nothing but is shown so an operator can clear it.
   */
  permissions: z.array(z.string()),
  /** Stored atoms that no longer exist in the code. */
  unknownPermissions: z.array(z.string()),
});
export type RoleDetail = z.infer<typeof roleDetail>;

export const roleListItemExample: RoleListItem = {
  id: '2',
  name: '运营',
  remark: '商品与营销',
  enabled: true,
  adminCount: 3,
  permissionCount: 12,
  createdAt: '2026-02-01T09:00:00+08:00',
};

export const roleDetailExample: RoleDetail = {
  ...roleListItemExample,
  permissions: ['coupon:template:read', 'coupon:template:write'],
  unknownPermissions: [],
};

export const roleListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    enabled: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'name', 'createdAt']).shape);
export type RoleListQuery = z.infer<typeof roleListQuery>;

export const pagedRoles = paged(roleListItem);

export const roleForm = z.object({
  name: z.string().trim().min(1, '请填写身份名称').max(64),
  remark: z.string().trim().max(255).nullable().optional(),
  enabled: z.boolean().default(true),
  permissions: z.array(z.string().max(128)).max(1000).default([]),
});
export type RoleForm = z.infer<typeof roleForm>;

export const roleStatusBody = z.object({ enabled: z.boolean() });
export type RoleStatusBody = z.infer<typeof roleStatusBody>;

/**
 * The permission tree the role editor renders, built from the atoms the code
 * declares — never from a database table. Two levels: section, then atom.
 */
export const permissionNode = z.object({
  atom: z.string(),
  label: z.string(),
  domain: z.string(),
  /** What a role given this atom is given with it: the reads its editor makes. */
  requires: z.array(z.string()),
});
export type PermissionNode = z.infer<typeof permissionNode>;

export const permissionSection = z.object({
  /** Group heading, e.g. `营销`. Falls back to the domain name. */
  section: z.string(),
  items: z.array(permissionNode),
});
export type PermissionSection = z.infer<typeof permissionSection>;

export const permissionTree = z.object({
  sections: z.array(permissionSection),
  /** Atoms every authenticated admin holds without a grant; shown disabled. */
  implicit: z.array(z.string()),
});
export type PermissionTree = z.infer<typeof permissionTree>;

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

/**
 * Who wrote an audit row: a console admin, or — only on rows older than the
 * cutover, which deleted the mobile staff console — a 店员. New rows are always
 * `admin`; `staff` stays so the historic rows still read back.
 */
export const auditActorKind = z.enum(['admin', 'staff']);
export type AuditActorKind = z.infer<typeof auditActorKind>;

export const auditLogItem = z.object({
  id,
  actorKind: auditActorKind,
  /** The console account, when `actorKind` is `admin` (null once it is deleted, or for a sign-in to an unknown account). */
  adminId: id.nullable(),
  /** The 店员's storefront user, when `actorKind` is `staff`. */
  userId: id.nullable(),
  /** The console account name, or `staff:<userId>` for a 店员. */
  adminAccount: z.string(),
  routeId: z.string(),
  method: z.string(),
  path: z.string(),
  target: z.string().nullable(),
  status: z.number().int(),
  /** Request body with secrets stripped, as stored. `null` when there was none. */
  payload: z.string().nullable(),
  requestId: z.string(),
  ip: z.string().nullable(),
  /** Set when the write came through an API token — an AI assistant or the `shop` CLI acting as the admin. */
  apiTokenId: id.nullable(),
  /** The token's name; `null` once it is gone, or when there was none. */
  apiTokenName: z.string().nullable(),
  createdAt: instant,
});
export type AuditLogItem = z.infer<typeof auditLogItem>;

export const auditLogItemExample: AuditLogItem = {
  id: '9001',
  actorKind: 'admin',
  adminId: '1',
  userId: null,
  adminAccount: 'admin',
  routeId: 'coupon.adminSetStatus',
  method: 'POST',
  path: '/admin-api/coupons/1/status',
  target: 'coupon:1',
  status: 200,
  payload: '{"status":"disabled"}',
  requestId: '6f1f6f0c-2f3a-4f7e-9f2f-0d2f5a1f2c33',
  ip: '203.0.113.7',
  apiTokenId: null,
  apiTokenName: null,
  createdAt: '2026-09-21T11:02:00+08:00',
};

export const auditLogListQuery = pageQuery
  .extend({
    actorKind: auditActorKind.optional(),
    adminId: id.optional(),
    /** A 店员's storefront user id. */
    userId: id.optional(),
    /** Matches `route_id`, `path` or `target`. */
    keyword: z.string().trim().max(128).optional(),
    routeId: z.string().trim().max(128).optional(),
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    createdFrom: instant.optional(),
    createdTo: instant.optional(),
  })
  .extend(sortQuery(['id', 'createdAt']).shape);
export type AuditLogListQuery = z.infer<typeof auditLogListQuery>;

export const pagedAuditLogs = paged(auditLogItem);

// ---------------------------------------------------------------------------
// config groups
// ---------------------------------------------------------------------------

/**
 * The field kinds the generic settings screen understands. Same list as the
 * admin kit's `ConfigFieldKind` plus the registry's richer image/file kinds,
 * which the descriptor endpoint narrows to `asset` before sending.
 */
export const configFieldKind = z.enum([
  'text',
  'textarea',
  'number',
  'switch',
  'select',
  'password',
  'json',
  'asset',
  'color',
  'richtext',
  'url',
]);
export type ConfigFieldKind = z.infer<typeof configFieldKind>;

/** What a `number` counts; `bytes` is edited in MB and stored in bytes. */
export const configFieldUnit = z.enum([
  'seconds',
  'minutes',
  'hours',
  'days',
  'ms',
  'bytes',
  'items',
]);
export type ConfigFieldUnit = z.infer<typeof configFieldUnit>;

export const configGroupCategory = z.enum(['basic', 'wechat', 'trade', 'integration', 'rules']);
export type ConfigGroupCategory = z.infer<typeof configGroupCategory>;

export const configSelectOption = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const configFieldDescriptor = z.object({
  key: z.string(),
  label: z.string(),
  kind: configFieldKind,
  help: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(configSelectOption).optional(),
  /** Section heading inside the group's form. */
  section: z.string().optional(),
  /** `asset` only. */
  multiple: z.boolean().optional(),
  /** Data-only conditional visibility, matching the kit's `ConfigVisibleWhen`. */
  visibleWhen: z.object({ key: z.string(), equals: z.unknown() }).optional(),
  /**
   * Written but never read back. The value in `values` is a boolean "is set"
   * flag, and saving without retyping leaves the stored secret alone.
   */
  secret: z.boolean().optional(),
  /**
   * Shown but not editable: an environment-derived deployment fact rather than
   * an operator's decision. The form renders the value as plain text, `help`
   * says where it comes from, and the save route refuses the key with
   * `CONFIG_FIELD_READ_ONLY`.
   */
  readOnly: z.boolean().optional(),
  /** `number` only. */
  unit: configFieldUnit.optional(),
});
export type ConfigFieldDescriptor = z.infer<typeof configFieldDescriptor>;

/**
 * The group's 「测试」 button, when it has one. The hook itself stays on the
 * server; this is what the screen needs to offer it.
 */
export const configTestDescriptor = z.object({
  label: z.string(),
  /** Asked before running: the test costs money or reaches a real person. */
  confirm: z.string().optional(),
  /** Filled in by the operator before running, e.g. the phone to text. */
  inputs: z.array(configFieldDescriptor),
  /** Keys of `inputs` the operator may leave blank. */
  optional: z.array(z.string()).optional(),
});
export type ConfigTestDescriptor = z.infer<typeof configTestDescriptor>;

export const configGroupDescriptor = z.object({
  group: z.string(),
  title: z.string(),
  description: z.string().optional(),
  category: configGroupCategory.optional(),
  /** Permission atom required to read and to write this group. */
  permission: z.string(),
  fields: z.array(configFieldDescriptor),
  test: configTestDescriptor.optional(),
});
export type ConfigGroupDescriptor = z.infer<typeof configGroupDescriptor>;

/** The last 「测试」 run on a group, kept for a while so the index can show it. */
export const configTestSummary = z.object({ ok: z.boolean(), at: instant });

/** The list entry; the fields are fetched with the group itself. */
export const configGroupSummary = configGroupDescriptor.omit({ fields: true, test: true }).extend({
  fieldCount: z.number().int().min(0),
  /** False when the caller may see the group exists but not open it. */
  writable: z.boolean(),
  /** Whether the group has a 「测试」 button at all. */
  testable: z.boolean().optional(),
  lastTest: configTestSummary.nullable().optional(),
  /** What the saved values amount to, e.g. 腾讯云 / 未启用 / 缺 AppCode. */
  status: z.object({ tone: z.enum(['on', 'off', 'incomplete']), text: z.string() }).optional(),
  /** Every field's label and section, so the index can search inside groups. */
  fieldIndex: z
    .array(z.object({ key: z.string(), label: z.string(), section: z.string().optional() }))
    .optional(),
});
export type ConfigGroupSummary = z.infer<typeof configGroupSummary>;

export const configGroupList = z.object({ groups: z.array(configGroupSummary) });

/**
 * A group's effective values.
 *
 * **Secrets never travel.** A `secret` field's value here is `true`/`false`
 * ("is set"), never the stored string. The same rule applies to the save
 * payload: a secret key absent from `values` leaves the stored value untouched.
 */
export const configGroupValues = z.object({
  descriptor: configGroupDescriptor,
  values: z.record(z.string(), z.unknown()),
  updatedAt: instant.nullable(),
});
export type ConfigGroupValues = z.infer<typeof configGroupValues>;

export const configSaveBody = z.object({
  values: z.record(z.string(), z.unknown()),
});
export type ConfigSaveBody = z.infer<typeof configSaveBody>;

export const configTestBody = z.object({
  /** The form as it stands, in the save payload's shape. Nothing is saved. */
  values: z.record(z.string(), z.unknown()),
  /** The test's own inputs (`descriptor.test.inputs`). */
  input: z.record(z.string(), z.unknown()).default({}),
});
export type ConfigTestBody = z.infer<typeof configTestBody>;

export const configTestResult = z.object({
  ok: z.boolean(),
  steps: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
      ms: z.number().int().min(0).optional(),
    }),
  ),
});
export type ConfigTestResult = z.infer<typeof configTestResult>;

export const configGroupParams = z.object({
  group: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, '配置分组名不合法'),
});

const siteDescriptorExample: ConfigGroupDescriptor = {
  group: 'site',
  title: '站点设置',
  description: '商城名称、Logo、备案号与联系方式。',
  permission: 'system:config:read',
  fields: [
    { key: 'siteName', label: '商城名称', kind: 'text', section: '基础' },
    { key: 'logo', label: '商城 Logo', kind: 'asset', section: '基础' },
    { key: 'icpNumber', label: 'ICP 备案号', kind: 'text', section: '备案' },
  ],
};

export const configGroupSummaryExample: ConfigGroupSummary = {
  group: 'site',
  title: '站点设置',
  description: '商城名称、Logo、备案号与联系方式。',
  permission: 'system:config:read',
  fieldCount: 3,
  writable: true,
};

export const configGroupValuesExample: ConfigGroupValues = {
  descriptor: siteDescriptorExample,
  values: {
    siteName: 'X-ZOO商城',
    logo: '/uploads/site/2026/09/2f8c1d.png',
    icpNumber: '京ICP备00000000号',
  },
  updatedAt: '2026-09-20T18:30:00+08:00',
};

// ---------------------------------------------------------------------------
// agreements
// ---------------------------------------------------------------------------

/**
 * The three legal texts the storefront shows. They are stored as the
 * `agreement` config group, so the admin edits them through the same generic
 * settings screen; these routes exist because the storefront must read them
 * without a session and without knowing about config groups.
 */
export const agreementKey = z.enum(['user', 'privacy', 'cancellation']);
export type AgreementKey = z.infer<typeof agreementKey>;

export const agreement = z.object({
  key: agreementKey,
  title: z.string(),
  /** HTML, as entered in the admin. Empty string when never filled in. */
  content: z.string(),
  updatedAt: instant.nullable(),
});
export type Agreement = z.infer<typeof agreement>;

export const agreementExample: Agreement = {
  key: 'user',
  title: '用户服务协议',
  content: '<p>欢迎使用本商城……</p>',
  updatedAt: '2026-09-20T18:30:00+08:00',
};

export const agreementParams = z.object({ key: agreementKey });

// ---------------------------------------------------------------------------
// the shop's own public settings
// ---------------------------------------------------------------------------

/**
 * What the storefront may read of the operator's own settings.
 *
 * **One route, not six.** The app needs the basics, the logos, the share card,
 * the copyright line, the 客服 setting and the splash screen, all on the first
 * screen a cold visitor sees. They are one payload the app fetches once and
 * caches by `version`.
 *
 * **Nothing secret is in here, by construction.** Every value is a field of the
 * `site`, `wechat-mini` or `payment` config group whose descriptor is *not*
 * `secret`, and `payments` carries booleans only: whether WeChat Pay is
 * configured, never a merchant id and never a key. `system.int.test.ts` states
 * that as a property over the whole registry rather than as a review habit.
 */
const siteText = z.string();
/** An asset URL, or `null` when the operator never filled that box in. */
const siteAsset = z.string().nullable();

export const sitePublicConfig = z.object({
  name: siteText,
  /**
   * Four slots, because a storefront renders four different logos: the
   * header, the sign-in form, the square icon a share card uses, and the
   * browser favicon on H5.
   */
  logo: z.object({
    main: siteAsset,
    login: siteAsset,
    square: siteAsset,
    favicon: siteAsset,
  }),
  copyright: z.object({
    text: siteText,
    /** Where the 版权 line points, or `null` for inert text. */
    link: z.string().nullable(),
    imageUrl: siteAsset,
  }),
  /** Defaults for `wx.updateAppMessageShareData`. */
  share: z.object({ title: siteText, synopsis: siteText, image: siteAsset }),
  /** 备案 — the footer the 工信部 requires on a Chinese site. */
  filing: z.object({
    icpNumber: siteText,
    icpUrl: siteText,
    publicSecurityNumber: siteText,
    publicSecurityUrl: siteText,
  }),
  /**
   * Which payment buttons the cashier may show. Booleans only, derived from
   * whether the gateway's credentials are complete. WeChat Pay v3 is the only
   * gateway, so it is the only key; the app's mapper reports every other
   * payment method as off.
   */
  payments: z.object({ wechat: z.boolean() }),
  /**
   * Which sign-in methods the app may offer. Booleans only, derived from
   * whether each method's settings are complete — never a credential, the same
   * rule as `payments`:
   *
   * - `wechatOa` — 公众号 one-tap login: the OA is switched on and its app id
   *   and secret are both filled in. The H5 build inside WeChat goes to
   *   `wechat_login` instead of the plain sign-in page.
   * - `wechatMini` — mini-program 授权登录: the mini program is switched on and
   *   its app id and secret are both filled in. Otherwise the mini-program
   *   sends a signed-out shopper to the phone + SMS page.
   * - `phone` — 手机号登录: an SMS sender is usable, so a code can be sent.
   *
   * The app's mapper turns them into the `wechat_status`, `wechat_auth_switch`
   * and `phone_auth_switch` flags its pages read.
   */
  auth: z.object({
    wechatOa: z.boolean(),
    wechatMini: z.boolean(),
    phone: z.boolean(),
  }),
  /**
   * The 客服 entry. `mini-program` means "open the mini-program's own chat",
   * `phone` means "dial `phone`", `none` means the button is not rendered.
   * `qrcodeUrl` is the 客服二维码 `components/kefuIcon` shows on H5 and is
   * independent of `kind` — a shop can have both.
   */
  support: z.object({
    kind: z.enum(['none', 'phone', 'mini-program']),
    phone: z.string().nullable(),
    qrcodeUrl: siteAsset,
  }),
  /** The launch splash. `enabled: false` means go straight to the home page. */
  splashAd: z.object({
    enabled: z.boolean(),
    imageUrl: siteAsset,
    link: z.string().nullable(),
    seconds: z.number().int().min(1),
  }),
  /**
   * Changes whenever any of the source groups is saved. The app keeps the
   * payload in storage and re-fetches only when this string moves; it is also
   * the `ETag`.
   */
  version: z.string(),
});
export type SitePublicConfig = z.infer<typeof sitePublicConfig>;

export const sitePublicConfigExample: SitePublicConfig = {
  name: 'X-ZOO商城',
  logo: {
    main: '/uploads/site/2026/09/2f8c1d.png',
    login: '/uploads/site/2026/09/7ab319.png',
    square: null,
    favicon: null,
  },
  copyright: {
    text: '© 2026 示例科技有限公司',
    link: 'https://example.test',
    imageUrl: null,
  },
  share: {
    title: '示例商城',
    synopsis: '好货不贵',
    image: '/uploads/site/2026/09/5c0de1.png',
  },
  filing: {
    icpNumber: '京ICP备00000000号',
    icpUrl: 'https://beian.miit.gov.cn/',
    publicSecurityNumber: '',
    publicSecurityUrl: '',
  },
  payments: { wechat: true },
  auth: { wechatOa: true, wechatMini: true, phone: true },
  support: { kind: 'phone', phone: '400-000-0000', qrcodeUrl: null },
  splashAd: {
    enabled: true,
    imageUrl: '/uploads/site/2026/09/a91f22.png',
    link: '/pages/product/index?id=12',
    seconds: 3,
  },
  version: '1758500000000',
};

// ---------------------------------------------------------------------------
// dashboard header
// ---------------------------------------------------------------------------

/**
 * The cards across the top of the admin home page.
 *
 * The shape is a *list of contributed tiles*, not a fixed record, because the
 * numbers come from several domains: `system` and `storage` contribute their
 * own and `stats` registers the order and user ones through
 * `DashboardContributor`. A tile whose contributor is not registered simply is
 * not in the list — the page never shows a zero it invented.
 */
export const dashboardTile = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  /** `count` renders plainly, `money` as ¥ with two decimals, `bytes` as KB/MB/GB. */
  format: z.enum(['count', 'money', 'bytes']),
  /** Optional admin link the tile navigates to. */
  href: z.string().nullable(),
  /** Comparison against the same figure yesterday; null when not meaningful. */
  deltaFromYesterday: z.number().nullable(),
  /**
   * The figure is work waiting for a person (「异常待处理」): the page shows a
   * non-zero value in the warning colour. Absent means an ordinary figure.
   */
  attention: z.boolean().optional(),
  /**
   * An `attention` tile's sources, one link each — 「异常支付 2 · 待处理任务 0 ·
   * 失败的后台任务 1」 — so the operator goes straight to the screen with the
   * work instead of the one `href` picked. Only the sources the admin may open.
   */
  parts: z
    .array(z.object({ key: z.string(), label: z.string(), value: z.number(), href: z.string() }))
    .optional(),
});
export type DashboardTile = z.infer<typeof dashboardTile>;

export const dashboardHeader = z.object({
  tiles: z.array(dashboardTile),
  /** Contributors that threw. The page renders what it has and shows this. */
  degraded: z.array(z.string()),
  generatedAt: instant,
});
export type DashboardHeader = z.infer<typeof dashboardHeader>;

export const dashboardHeaderExample: DashboardHeader = {
  tiles: [
    {
      key: 'system.attention',
      label: '异常待处理',
      value: 3,
      format: 'count',
      href: '/admin/trade/payment-exceptions',
      deltaFromYesterday: null,
      attention: true,
      parts: [
        {
          key: 'payment.exceptions',
          label: '异常支付',
          value: 2,
          href: '/admin/trade/payment-exceptions',
        },
        { key: 'effects', label: '待处理任务', value: 0, href: '/admin/trade/effects' },
        { key: 'failedJobs', label: '失败的后台任务', value: 1, href: '/admin/system/failed-jobs' },
      ],
    },
    {
      key: 'system.admins',
      label: '管理员',
      value: 4,
      format: 'count',
      href: '/admin/system/admins',
      deltaFromYesterday: null,
    },
    {
      key: 'storage.attachments',
      label: '素材数量',
      value: 1280,
      format: 'count',
      href: '/admin/storage/attachments',
      deltaFromYesterday: 12,
    },
    {
      key: 'storage.bytes',
      label: '素材占用',
      value: 734003200,
      format: 'bytes',
      href: null,
      deltaFromYesterday: null,
    },
  ],
  degraded: [],
  generatedAt: '2026-09-22T09:00:00+08:00',
};

// ---------------------------------------------------------------------------
// failed background jobs
// ---------------------------------------------------------------------------

/**
 * A background job that used up its retries (`failed_jobs`). `jobName` is the
 * worker's job id (`order.autoCancel`); the screen shows it as words. `error` is
 * the last failure as the worker saw it — staff-only detail, never shown to a
 * shopper.
 */
export const failedJobItem = z.object({
  id,
  jobName: z.string(),
  /**
   * Raw diagnostic text (an exception's message), for whoever debugs it.
   * Staff-only and shown only under 技术详情: the screen shows `errorSummary`.
   */
  error: z.string(),
  /** The same failure in Chinese, what staff read. */
  errorSummary: z.string(),
  attempts: z.number().int().min(0),
  createdAt: instant,
  resolvedAt: instant.nullable(),
});
export type FailedJobItem = z.infer<typeof failedJobItem>;

export const failedJobListQuery = pageQuery.extend({
  /** `open`: still waiting for a person (the default); `resolved`: marked 已处理. */
  status: z.enum(['open', 'resolved']).default('open'),
});
export type FailedJobListQuery = z.infer<typeof failedJobListQuery>;

export const pagedFailedJobs = paged(failedJobItem);

export const failedJobParams = z.object({ id });

/** `resolved: false` — somebody marked it first; nothing changed. */
export const failedJobResolveResult = z.object({ resolved: z.boolean() });

export const failedJobItemExample: FailedJobItem = {
  id: '12',
  jobName: 'order.sweepExpiredOrders',
  error: 'connect ETIMEDOUT',
  errorSummary: '重试 3 次后仍然失败，请联系技术人员查看服务器日志',
  attempts: 3,
  createdAt: '2026-09-25T04:00:12+08:00',
  resolvedAt: null,
};
