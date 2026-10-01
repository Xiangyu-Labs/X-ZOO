import { registerUserLookup } from '../auth/user-lookup';
import * as repo from './user.repo';
import { wechatIdentityAdapter } from './wechat-identity.adapter';
import { registerWechatIdentityPort } from './wechat-identity.port';
import { registerAppConfigSource } from '../system';
import { storefrontAuthConfig } from './storefront-auth.config';
import { registerMediaRiskHandler } from '../wechat';
import { resetRiskyAvatar } from './user-avatar-check';

/**
 * The `user` domain's public surface: storefront customers, their addresses,
 * their sign-in, and the operator screens behind them.
 *
 * | Caller | Entry point |
 * | --- | --- |
 * | `GET/PUT /api/v1/profile` | `getProfile` / `updateProfile` |
 * | `/api/v1/addresses…` | `addressList` / `defaultAddress` / `addressDetail` / `addressCreate` / `addressUpdate` / `addressDelete` / `addressSetDefault` |
 * | `/api/v1/invoice-titles…` | `invoiceTitleList` / `invoiceTitleDefault` / `invoiceTitleDetail` / `invoiceTitleCreate` / `invoiceTitleUpdate` / `invoiceTitleDelete` / `invoiceTitleSetDefault` |
 * | `/api/v1/account-cancellations…` | `requestCancellation` / `currentCancellation` / `withdrawCancellation` |
 * | `POST /api/v1/auth/sms-codes` | `sendSmsCode` |
 * | `POST /api/v1/auth/sessions/*` | `passwordLogin` / `smsLogin` / `miniLogin` / `miniPhoneLogin` / `oaLogin` / `oaPhoneLogin` |
 * | `DELETE /api/v1/auth/sessions…` | `logout` / `logoutEverywhere` |
 * | `POST /api/v1/auth/registrations`, `…/password-resets`, `PUT …/password` | `register` / `resetPassword` / `changePassword` |
 * | `POST/PUT /api/v1/auth/phone` | `bindPhone` / `changePhone` |
 * | `GET /api/v1/auth/wechat-oa/authorize-url` | `oaAuthorizeUrl` |
 * | `POST /api/v1/visits` | `recordVisit` |
 * | worker `user.pruneVisits` | `pruneVisits` — the page-view retention sweep |
 * | `/admin-api/users…` | `adminList` / `adminCreate` / `adminDetail` / `adminUpdate` / `adminSetStatus` / `adminResetPassword` / `adminAddressList` / `adminBatchSetGroups` / `adminBatchSetLabels` |
 * | `/admin-api/user-groups…`, `/admin-api/user-labels…`, `/admin-api/user-label-categories…` | the taxonomy CRUD below |
 * | `/admin-api/user-cancellations…` | `adminCancellationList` / `adminApproveCancellation` / `adminRejectCancellation` / `adminRemarkCancellation` |
 *
 * **What importing this module registers**, through `registerUserDomain()`
 * (the idempotent shape `@shop/core/domains` looks for):
 *
 * 1. the `storefront-auth` config group, so the generic settings screen can
 *    list it (a plain import side effect);
 * 2. `registerUserLookup` — the real implementation of the auth domain's
 *    user-lookup seam. Until this runs, `UserSessionService.resolve` fails
 *    closed and *every* storefront session is rejected — which is the safe
 *    direction;
 * 3. the `WechatIdentityPort` over the `wechat` domain's client
 *    (`wechat-identity.adapter.ts`). A test that wants the fake calls
 *    `registerWechatIdentityPort(fakeWechatIdentityPort())` after this;
 * 4. from the bootstrap only (not a bare import): the `wechatRequiresPhone`
 *    reader behind `GET /api/v1/app/config`.
 *
 * **What other domains need from here.**
 *
 * | Need | Reach for |
 * | --- | --- |
 * | the signed-in shopper's profile | `getProfile(ctx)` |
 * | the address an order ships to | `defaultAddress(ctx)` / `addressDetail(ctx, { id })` |
 * | the users the 客户列表's filters match | `userIdsForFilter(db, filter, cap)` |
 * | a different WeChat identity source (tests) | `registerWechatIdentityPort(impl)` |
 * | a different SMS provider | `registerSmsSender(impl)` from `@shop/core/sms` |
 * | to forget a copy of a shopper's nickname or avatar on 注销 | `onAccountCancelled(domain, listener)` |
 *
 * Nothing else reaches `user.repo.ts`; it is the only file in the system that
 * may touch `users`, and a second one would make "who can disable an account"
 * unanswerable.
 */

export function registerUserDomain(): void {
  registerUserPorts();
  // 内容安全 (C09): a WeChat `risky` verdict on an avatar puts the default back;
  // `notification` listens (`onAvatarRejected`) and tells the customer.
  registerMediaRiskHandler('avatar', resetRiskyAvatar);
  // `GET /api/v1/app/config` says up front whether a first WeChat sign-in will
  // ask for a phone. The setting is ours (`storefront-auth`) and `system` may
  // not import this domain, so the answer crosses as a reader. Only from the
  // bootstrap, never at import: this module can be reached while `system` is
  // still evaluating, and its registry would not exist yet.
  registerAppConfigSource('wechatRequiresPhone', {
    groups: [storefrontAuthConfig.group],
    read: async (ctx) => (await ctx.config.get(storefrontAuthConfig)).requirePhoneForWechat,
  });
}

/** The two ports, which a bare import has always installed and still does. */
function registerUserPorts(): void {
  registerUserLookup({
    findAuthState: (db, userId) => repo.findAuthState(db, userId),
  });
  registerWechatIdentityPort(wechatIdentityAdapter);
}

registerUserPorts();

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

export {
  addressCreate,
  addressDelete,
  addressDetail,
  addressList,
  addressSetDefault,
  addressUpdate,
  currentCancellation,
  defaultAddress,
  getProfile,
  requestCancellation,
  updateProfile,
  withdrawCancellation,
} from './user.service';

export {
  bindPhone,
  bindPhoneFromMini,
  changePassword,
  changePhone,
  isAllowedRedirect,
  logout,
  logoutEverywhere,
  miniLogin,
  miniPhoneLogin,
  oaAuthorizeUrl,
  oaLogin,
  oaPhoneLogin,
  passwordLogin,
  register,
  resetPassword,
  sendSmsCode,
  smsLogin,
  type RequestMeta,
} from './storefront-auth.service';

export {
  invoiceTitleCreate,
  invoiceTitleDefault,
  invoiceTitleDelete,
  invoiceTitleDetail,
  invoiceTitleList,
  invoiceTitleSetDefault,
  invoiceTitleUpdate,
} from './invoice-title.service';

export { pruneVisits, recordVisit } from './user.visit.service';

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export {
  adminAddressList,
  adminApproveCancellation,
  adminBatchSetGroups,
  adminBatchSetLabels,
  adminCancellationList,
  adminDetail,
  adminList,
  adminRejectCancellation,
  adminRemarkCancellation,
  adminResetPassword,
  adminSetStatus,
  adminUpdate,
  adminCreate,
  groupCreate,
  groupDelete,
  groupList,
  groupUpdate,
  labelCategoryCreate,
  labelCategoryDelete,
  labelCategoryList,
  labelCategoryUpdate,
  labelCreate,
  labelDelete,
  labelList,
  labelUpdate,
  userIdsForFilter,
  type AdminUserFilter,
} from './user-admin.service';

// ---------------------------------------------------------------------------
// seams
// ---------------------------------------------------------------------------

export { storefrontAuthConfig, type StorefrontAuthConfig } from './storefront-auth.config';
export { userPermissions } from './permissions';

export {
  fakeWechatIdentityPort,
  getWechatIdentityPort,
  registerWechatIdentityPort,
  resetWechatIdentityPort,
  type FakeWechatIdentityPort,
  type WechatIdentityPort,
  type WechatMiniSession,
  type WechatOaUser,
  type WechatPhoneNumber,
} from './wechat-identity.port';

export {
  onAccountCancelled,
  type AccountCancelledEvent,
  type AccountCancelledListener,
} from './user-cancelled';

export {
  AVATAR_REJECTED_EVENT,
  onAvatarRejected,
  type AvatarRejectedEvent,
  type AvatarRejectedListener,
} from './user-avatar-check';

export { hasStarterProfile, maskPhone } from './user.rules';

/** The member's phone for a notification SMS; `notification` has no other way to it. */
export { findPhone as findUserPhone } from './user.repo';
