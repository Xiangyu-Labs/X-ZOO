import { z } from 'zod';
import {
  clientPlatform,
  id,
  instant,
  newPassword,
  pageQuery,
  paged,
  sortQuery,
} from '../_conventions/common';
import {
  invoiceHeaderInput,
  invoiceHeaderType,
  invoiceType,
  withInvoiceHeaderRules,
  type InvoiceHeaderInput,
} from '../order/order.fulfil.schemas';

/**
 * Shapes shared by the user routes.
 *
 * The enums are the PostgreSQL enums of `db/src/schema/user.ts`, spelled the
 * same way and *not* imported from `@shop/db` — contracts are the bottom layer.
 * `user.service.ts` assigns one to the other and stops compiling if they drift.
 *
 * Deliberately absent, because the columns are gone with the features that used
 * them: balance, points, experience, member level, referrer / distribution
 * chain, sign-in streak, agent / staff flags. A customer here is an identity
 * with addresses, labels and invoice profiles — nothing more.
 */

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/**
 * A mainland mobile number, digits only.
 *
 * `/^1[3-9]\d{9}$/`, the same rule the auth contracts apply. It is repeated
 * here rather than shared with the auth contracts because the two domains must
 * be able to move independently; the regex is three tokens long and a shared
 * constant would be a dependency for no gain.
 */
export const phoneNumber = z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确');

/** What an operator sees in a list: `138****8000`. Never the whole number. */
export const maskedPhone = z.string();

export const userStatus = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof userStatus>;

/** Where the account came from. `admin` means an operator typed it in. */
export const userRegisterSource = z.enum(['h5', 'wechat_oa', 'wechat_mini', 'admin']);
export type UserRegisterSource = z.infer<typeof userRegisterSource>;

/** Which WeChat app an identity belongs to. */
export const wechatPlatform = z.enum(['oa', 'mini']);
export type WechatPlatform = z.infer<typeof wechatPlatform>;

// ---------------------------------------------------------------------------
// storefront profile
// ---------------------------------------------------------------------------

/**
 * The shopper's own profile.
 *
 * `phone` is the real number, not the masked one: it is their own. The admin
 * list masks it because an operator browsing 10 000 customers has no business
 * reading every number, and a screenshot of that table used to be a leak.
 *
 * `hasPassword` exists because an account created by SMS code or by WeChat has
 * no password at all, and the 修改密码 screen must offer "set" rather than
 * "change" — asking for the old password would be unanswerable.
 */
export const userProfile = z.object({
  id,
  account: z.string(),
  phone: z.string().nullable(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  realName: z.string().nullable(),
  birthday: instant.nullable(),
  registerSource: userRegisterSource.nullable(),
  hasPassword: z.boolean(),
  /** Which WeChat apps this account is already bound to. */
  boundWechat: z.array(wechatPlatform),
  createdAt: instant,
});
export type UserProfile = z.infer<typeof userProfile>;

/**
 * What a shopper may change about themselves.
 *
 * Not the phone (that is `POST /api/v1/auth/phone`, which needs an SMS code)
 * and not the account name (it is the login identity).
 *
 * `avatarUrl` must be one of: the URL `POST /api/v1/uploads?purpose=avatar`
 * returned (any live image in our storage), the account's current avatar
 * (clients re-send it on every save), or the shop's configured default avatar.
 * Anything else is `USER_AVATAR_NOT_ALLOWED` (USER-019). `''` clears it. In
 * the mini-program, `<button open-type="chooseAvatar">` gives a temporary file:
 * upload it first, then save the returned URL.
 *
 * `nickname` is trimmed; one that is only whitespace is refused.
 */
export const userProfileForm = z.object({
  nickname: z.string().min(1).max(64).optional(),
  avatarUrl: z.string().max(512).optional(),
  realName: z.string().max(32).optional(),
  birthday: instant.nullish(),
});
export type UserProfileForm = z.infer<typeof userProfileForm>;

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

export const userAddress = z.object({
  id,
  receiverName: z.string(),
  receiverPhone: z.string(),
  provinceId: id.nullable(),
  cityId: id.nullable(),
  districtId: id.nullable(),
  provinceName: z.string(),
  cityName: z.string(),
  districtName: z.string().nullable(),
  detail: z.string(),
  postCode: z.string().nullable(),
  lng: z.string().nullable(),
  lat: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});
export type UserAddress = z.infer<typeof userAddress>;

/**
 * Create / update an address.
 *
 * The division *names* are required and the ids are optional, which is the
 * reverse of what a normalised design would ask for — but a region picker
 * can return a hand-typed 海外 address with no division id, and refusing it
 * would make the shop unusable for exactly the customers who complain loudest.
 * The names are frozen at save time so renaming a district later does not
 * rewrite the delivery history.
 */
export const userAddressForm = z.object({
  receiverName: z.string().min(1).max(32),
  receiverPhone: phoneNumber,
  provinceId: id.optional(),
  cityId: id.optional(),
  districtId: id.optional(),
  provinceName: z.string().min(1).max(64),
  cityName: z.string().min(1).max(64),
  districtName: z.string().max(64).optional(),
  detail: z.string().min(1).max(255),
  postCode: z
    .string()
    .regex(/^\d{6}$/, '邮政编码为 6 位数字')
    .optional(),
  lng: z
    .string()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, '经度格式不正确')
    .optional(),
  lat: z
    .string()
    .regex(/^-?\d{1,2}(\.\d{1,6})?$/, '纬度格式不正确')
    .optional(),
  /** The first address a customer saves becomes the default whatever this says. */
  isDefault: z.boolean().default(false),
});
export type UserAddressForm = z.infer<typeof userAddressForm>;

export const userAddressListQuery = pageQuery;
export const pagedUserAddresses = paged(userAddress);

// ---------------------------------------------------------------------------
// invoice titles (发票抬头)
// ---------------------------------------------------------------------------

/**
 * A saved 发票抬头.
 *
 * The field names are the ones `POST /api/v1/orders/:id/invoice` takes, so
 * prefilling a request is a copy (`invoiceRequestFromTitle`), not a mapping.
 * The request freezes the fields onto the invoice, so editing or deleting a
 * title later never rewrites an invoice already asked for.
 */
export const invoiceTitle = z.object({
  id,
  headerType: invoiceHeaderType,
  invoiceType,
  name: z.string(),
  dutyNumber: z.string().nullable(),
  drawerPhone: z.string().nullable(),
  email: z.string().nullable(),
  registeredTel: z.string().nullable(),
  registeredAddress: z.string().nullable(),
  bankName: z.string().nullable(),
  bankAccount: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});
export type InvoiceTitle = z.infer<typeof invoiceTitle>;

/**
 * Create / update a title: exactly the request's header fields and rules
 * (company needs a 税号, 专票 needs the four bank/registration fields), plus
 * `isDefault`. An empty string is stored as "not given".
 */
export const invoiceTitleForm = withInvoiceHeaderRules(
  invoiceHeaderInput.extend({
    /** The first title a customer saves becomes the default whatever this says. */
    isDefault: z.boolean().default(false),
  }),
);
export type InvoiceTitleForm = z.infer<typeof invoiceTitleForm>;

export const invoiceTitleListQuery = pageQuery;
export const pagedInvoiceTitles = paged(invoiceTitle);

/**
 * The `POST /api/v1/orders/:id/invoice` body a saved title prefills: every
 * non-empty header field, nothing else. The caller adds a `remark` if it has
 * one. Pure, so the storefront and the tests share it.
 */
export function invoiceRequestFromTitle(title: InvoiceTitle): InvoiceHeaderInput {
  const optional = (value: string | null): string | undefined =>
    value === null || value === '' ? undefined : value;
  const body: InvoiceHeaderInput = {
    headerType: title.headerType,
    invoiceType: title.invoiceType,
    name: title.name,
  };
  const fields = [
    'dutyNumber',
    'drawerPhone',
    'email',
    'registeredTel',
    'registeredAddress',
    'bankName',
    'bankAccount',
  ] as const;
  for (const field of fields) {
    const value = optional(title[field]);
    if (value !== undefined) body[field] = value;
  }
  return body;
}

// ---------------------------------------------------------------------------
// account cancellation
// ---------------------------------------------------------------------------

export const cancellationStatus = z.enum(['pending', 'approved', 'rejected', 'withdrawn']);
export type CancellationStatus = z.infer<typeof cancellationStatus>;

/**
 * One 注销申请.
 *
 * `nickname` and `phone` are frozen copies: approving a request anonymises the
 * `users` row, so a reviewer looking at the list afterwards would otherwise see
 * nothing but an id.
 */
export const cancellationRequest = z.object({
  id,
  userId: id,
  nickname: z.string().nullable(),
  phone: z.string().nullable(),
  reason: z.string().nullable(),
  status: cancellationStatus,
  reviewRemark: z.string().nullable(),
  reviewedAt: instant.nullable(),
  createdAt: instant,
});
export type CancellationRequest = z.infer<typeof cancellationRequest>;

export const cancellationRequestForm = z.object({
  reason: z.string().max(500).optional(),
});
export type CancellationRequestForm = z.infer<typeof cancellationRequestForm>;

export const cancellationReviewBody = z.object({
  remark: z.string().max(255).optional(),
});
export type CancellationReviewBody = z.infer<typeof cancellationReviewBody>;

export const cancellationRemarkBody = z.object({
  remark: z.string().max(255),
});
export type CancellationRemarkBody = z.infer<typeof cancellationRemarkBody>;

export const cancellationListQuery = pageQuery
  .extend({
    status: cancellationStatus.optional(),
    keyword: z.string().trim().max(64).optional(),
  })
  .extend(sortQuery(['id', 'createdAt']).shape);
export type CancellationListQuery = z.infer<typeof cancellationListQuery>;

export const pagedCancellationRequests = paged(cancellationRequest);

// ---------------------------------------------------------------------------
// groups and labels
// ---------------------------------------------------------------------------

export const userGroup = z.object({
  id,
  name: z.string(),
  sortOrder: z.number().int(),
  /** How many customers are in it. The list is short; the count is what operators sort by. */
  memberCount: z.number().int().min(0),
  createdAt: instant,
});
export type UserGroup = z.infer<typeof userGroup>;

export const userGroupForm = z.object({
  name: z.string().trim().min(1).max(64),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type UserGroupForm = z.infer<typeof userGroupForm>;

export const userGroupListQuery = pageQuery.extend(sortQuery(['id', 'name', 'sortOrder']).shape);
export const pagedUserGroups = paged(userGroup);

export const userLabelCategory = z.object({
  id,
  name: z.string(),
  sortOrder: z.number().int(),
  createdAt: instant,
});
export type UserLabelCategory = z.infer<typeof userLabelCategory>;

export const userLabelCategoryForm = z.object({
  name: z.string().trim().min(1).max(64),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type UserLabelCategoryForm = z.infer<typeof userLabelCategoryForm>;

export const userLabelCategoryListQuery = pageQuery.extend(
  sortQuery(['id', 'name', 'sortOrder']).shape,
);
export const pagedUserLabelCategories = paged(userLabelCategory);

export const userLabel = z.object({
  id,
  categoryId: id.nullable(),
  categoryName: z.string().nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
  memberCount: z.number().int().min(0),
  createdAt: instant,
});
export type UserLabel = z.infer<typeof userLabel>;

export const userLabelForm = z.object({
  categoryId: id.nullish(),
  name: z.string().trim().min(1).max(64),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type UserLabelForm = z.infer<typeof userLabelForm>;

export const userLabelListQuery = pageQuery
  .extend({ categoryId: id.optional(), keyword: z.string().trim().max(64).optional() })
  .extend(sortQuery(['id', 'name', 'sortOrder']).shape);
export type UserLabelListQuery = z.infer<typeof userLabelListQuery>;

export const pagedUserLabels = paged(userLabel);

// ---------------------------------------------------------------------------
// admin: customers
// ---------------------------------------------------------------------------

/** A group or label as it appears attached to a customer. */
export const namedRef = z.object({ id, name: z.string() });
export type NamedRef = z.infer<typeof namedRef>;

export const adminUserListItem = z.object({
  id,
  account: z.string(),
  /** Masked: `138****8000`. The unmasked number is on the detail route. */
  phone: maskedPhone.nullable(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: userStatus,
  registerSource: userRegisterSource.nullable(),
  groups: z.array(namedRef),
  labels: z.array(namedRef),
  lastLoginAt: instant.nullable(),
  createdAt: instant,
});
export type AdminUserListItem = z.infer<typeof adminUserListItem>;

/**
 * The detail drawer.
 *
 * The orders / coupons tabs are **not** here: they are the owning domains' own
 * admin list routes filtered by `userId`, so this domain never reads another
 * domain's tables and a change to the order list shape cannot break this page.
 */
export const adminUserDetail = adminUserListItem.extend({
  /** Unmasked, and only on this route — which carries its own permission. */
  phone: z.string().nullable(),
  realName: z.string().nullable(),
  birthday: instant.nullable(),
  adminRemark: z.string().nullable(),
  registerIp: z.string().nullable(),
  lastLoginIp: z.string().nullable(),
  hasPassword: z.boolean(),
  boundWechat: z.array(wechatPlatform),
  addressCount: z.number().int().min(0),
  /** Set once a cancellation request was approved; the row is kept for order history. */
  deletedAt: instant.nullable(),
  updatedAt: instant,
});
export type AdminUserDetail = z.infer<typeof adminUserDetail>;

/**
 * What an operator may edit.
 *
 * Not the phone: rebinding a number is the customer's own act, guarded by an
 * SMS code, and an operator who could silently repoint an account at their own
 * handset would own every account in the shop.
 */
export const adminUserForm = z.object({
  nickname: z.string().trim().min(1).max(64).optional(),
  /** `null` clears it; absent leaves it as it is. */
  realName: z.string().trim().max(32).nullish(),
  birthday: instant.nullish(),
  /** `null` clears it; absent leaves it as it is. */
  adminRemark: z.string().trim().max(255).nullish(),
  groupIds: z.array(id).max(50).default([]),
  labelIds: z.array(id).max(50).default([]),
});
export type AdminUserForm = z.infer<typeof adminUserForm>;

/**
 * 新增用户: an operator opens an account for a customer who has not signed up
 * themselves. The phone number is the login, as it is for a shopper who
 * registers by SMS; the password is optional — without one the customer signs
 * in with an SMS code or WeChat, bound to the same phone.
 */
export const adminUserCreateBody = adminUserForm.extend({
  phone: phoneNumber,
  password: newPassword(6).optional(),
});
export type AdminUserCreateBody = z.infer<typeof adminUserCreateBody>;

export const adminUserListQuery = pageQuery
  .extend({
    /** Matches account, phone, nickname or real name. */
    keyword: z.string().trim().max(64).optional(),
    groupId: id.optional(),
    labelId: id.optional(),
    status: userStatus.optional(),
    registerSource: userRegisterSource.optional(),
    /** Registration window, inclusive of both ends. */
    createdFrom: instant.optional(),
    createdTo: instant.optional(),
    /**
     * `true` = only accounts with a bound WeChat identity, `false` = only those
     * without.
     *
     * Spelled as the two literal strings rather than `z.coerce.boolean()`,
     * which turns the string `"false"` — the only way a query string can say
     * false — into `true`, so the "未绑定" filter would have silently shown the
     * bound accounts.
     */
    hasWechat: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'lastLoginAt']).shape);
export type AdminUserListQuery = z.infer<typeof adminUserListQuery>;

export const pagedAdminUsers = paged(adminUserListItem);

export const adminUserStatusBody = z.object({
  status: userStatus,
});
export type AdminUserStatusBody = z.infer<typeof adminUserStatusBody>;

/**
 * Operator-set password.
 *
 * There is no "send the customer their new password" — the operator reads it
 * out. Either way every live session of that account dies, which is the point:
 * a reset is what support does when an account is suspected stolen.
 */
export const adminUserPasswordBody = z.object({
  password: newPassword(6),
});
export type AdminUserPasswordBody = z.infer<typeof adminUserPasswordBody>;

/** Batch set group / label membership from the list's selection. */
export const adminUserBatchGroupBody = z.object({
  userIds: z.array(id).min(1).max(500),
  groupIds: z.array(id).max(50),
  /** `replace` overwrites the membership, `add` unions it, `remove` subtracts it. */
  mode: z.enum(['replace', 'add', 'remove']).default('replace'),
});
export type AdminUserBatchGroupBody = z.infer<typeof adminUserBatchGroupBody>;

export const adminUserBatchLabelBody = z.object({
  userIds: z.array(id).min(1).max(500),
  labelIds: z.array(id).max(50),
  mode: z.enum(['replace', 'add', 'remove']).default('replace'),
});
export type AdminUserBatchLabelBody = z.infer<typeof adminUserBatchLabelBody>;

export const batchResult = z.object({
  affected: z.number().int().min(0),
});
export type BatchResult = z.infer<typeof batchResult>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

export const userProfileExample: UserProfile = {
  id: '1001',
  account: '13800138000',
  phone: '13800138000',
  nickname: '小明',
  avatarUrl: 'https://cdn.example.com/2026/09/a1b2c3d4.png',
  realName: null,
  birthday: null,
  registerSource: 'h5',
  hasPassword: true,
  boundWechat: [],
  createdAt: '2026-01-05T10:00:00+08:00',
};

export const userAddressExample: UserAddress = {
  id: '5001',
  receiverName: '张三',
  receiverPhone: '13800138000',
  provinceId: '110000',
  cityId: '110100',
  districtId: '110105',
  provinceName: '北京市',
  cityName: '北京市',
  districtName: '朝阳区',
  detail: '建国路 88 号 SOHO 尚都 1201',
  postCode: '100022',
  lng: '116.472644',
  lat: '39.913423',
  isDefault: true,
  createdAt: '2026-01-06T09:00:00+08:00',
  updatedAt: '2026-01-06T09:00:00+08:00',
};

export const invoiceTitleExample: InvoiceTitle = {
  id: '7001',
  headerType: 'company',
  invoiceType: 'plain',
  name: '杭州某某科技有限公司',
  dutyNumber: '91330100MA2XXXXX0A',
  drawerPhone: '13800138000',
  email: 'finance@example.com',
  registeredTel: null,
  registeredAddress: null,
  bankName: null,
  bankAccount: null,
  isDefault: true,
  createdAt: '2026-01-06T09:00:00+08:00',
  updatedAt: '2026-01-06T09:00:00+08:00',
};

export const invoiceTitleSpecialExample: InvoiceTitle = {
  ...invoiceTitleExample,
  id: '7002',
  invoiceType: 'special',
  registeredTel: '0571-88888888',
  registeredAddress: '杭州市西湖区文三路 100 号',
  bankName: '中国工商银行杭州分行',
  bankAccount: '1202020209000000000',
  isDefault: false,
};

export const cancellationRequestExample: CancellationRequest = {
  id: '31',
  userId: '1001',
  nickname: '小明',
  phone: '138****8000',
  reason: '不再使用了',
  status: 'pending',
  reviewRemark: null,
  reviewedAt: null,
  createdAt: '2026-09-01T14:20:00+08:00',
};

export const userGroupExample: UserGroup = {
  id: '3',
  name: '高价值客户',
  sortOrder: 10,
  memberCount: 128,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const userLabelCategoryExample: UserLabelCategory = {
  id: '2',
  name: '消费偏好',
  sortOrder: 0,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const userLabelExample: UserLabel = {
  id: '7',
  categoryId: '2',
  categoryName: '消费偏好',
  name: '母婴',
  sortOrder: 0,
  memberCount: 42,
  createdAt: '2026-01-01T10:05:00+08:00',
};

export const adminUserListItemExample: AdminUserListItem = {
  id: '1001',
  account: '13800138000',
  phone: '138****8000',
  nickname: '小明',
  avatarUrl: 'https://cdn.example.com/2026/09/a1b2c3d4.png',
  status: 'active',
  registerSource: 'h5',
  groups: [{ id: '3', name: '高价值客户' }],
  labels: [{ id: '7', name: '母婴' }],
  lastLoginAt: '2026-09-20T08:31:00+08:00',
  createdAt: '2026-01-05T10:00:00+08:00',
};

export const adminUserDetailExample: AdminUserDetail = {
  ...adminUserListItemExample,
  phone: '13800138000',
  realName: null,
  birthday: null,
  adminRemark: null,
  registerIp: '203.0.113.7',
  lastLoginIp: '203.0.113.9',
  hasPassword: true,
  boundWechat: ['mini'],
  addressCount: 2,
  deletedAt: null,
  updatedAt: '2026-09-20T08:31:00+08:00',
};

// ---------------------------------------------------------------------------
// the visits beacon
// ---------------------------------------------------------------------------

/**
 * One storefront page view.
 *
 * `path` is the **route**, not the URL: no origin, no query string, and no
 * fragment. Two reasons. A query string carries `?code=` from the WeChat OAuth
 * redirect and `?phone=` from a share link, so storing it turns an analytics
 * table into a credential log that nobody remembers to purge. And 访客数 is
 * grouped by path: with the query string attached, one product page becomes one
 * row per referrer and the 热门页面 list is noise.
 *
 * The visitor is never named in the body. Who they are is the bearer token, or
 * — for somebody who has not signed in — the address the request came from,
 * both read off the request by the server. A `userId` a client could put in a
 * beacon body would let anybody write page views onto anybody's account. The
 * province a visit is counted under is likewise the server's to decide (the
 * signed-in visitor's default address), never the body's.
 *
 * A page view is reported twice: once when the page is shown (no `stayMs`) —
 * that is the view — and once when it is hidden or closed, with `stayMs`, the
 * time it was on screen. The second report never adds a view; it attaches the
 * time to the view the first one recorded.
 */
export const visitBody = z.object({
  path: z
    .string()
    .min(1)
    .max(255)
    .regex(/^\/[^?#\s]*$/, '页面路径格式不正确'),
  /** Omitted means "whatever `X-Client-Platform` said", which is the usual case. */
  platform: clientPlatform.optional(),
  /**
   * Milliseconds the page was on screen, sent when it is hidden. At most a day
   * on the wire; the server caps what one view can be credited with far lower,
   * and never beyond the time since the view was recorded.
   */
  stayMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type VisitBody = z.infer<typeof visitBody>;
