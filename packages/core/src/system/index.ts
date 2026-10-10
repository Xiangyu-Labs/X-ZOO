/**
 * `system` — who may use the admin, what they did, and every setting.
 *
 * | Caller | Entry point |
 * | --- | --- |
 * | `GET/POST/PUT /admin-api/admins…` | `adminList` / `adminDetail` / `adminCreate` / `adminUpdate` |
 * | `POST /admin-api/admins/:id/status` / `…/password` | `adminSetStatus` / `adminResetPassword` |
 * | `DELETE /admin-api/admins/:id` | `adminDelete` |
 * | `GET/PUT /admin-api/profile`, `POST /admin-api/profile/password` | `profileGet` / `profileUpdate` / `profileChangePassword` |
 * | `GET/POST/PUT/DELETE /admin-api/roles…` | `roleList` / `roleDetail` / `roleCreate` / `roleUpdate` / `roleSetStatus` / `roleDelete` |
 * | `GET /admin-api/permissions` | `permissionTreeRoute` |
 * | `GET /admin-api/audit-logs` | `auditLogList` |
 * | `GET /admin-api/failed-jobs`, `POST …/:id/resolve` | `failedJobList` / `failedJobResolve` |
 * | `GET /admin-api/system/config-groups` | `configGroupList` |
 * | `GET/PUT /admin-api/system/config/:group` | `configGet` / `configSave` |
 * | `POST /admin-api/system/config/:group/test` | `configTest` |
 * | `GET /api/v1/agreements/:key` | `agreementGet` |
 * | `GET /api/v1/app/config` | `appConfigGet` |
 * | `GET /admin-api/dashboard/header` | `dashboardHeader` |
 * | worker `system.pruneAuditLogs` | `pruneAuditLogs` |
 *
 * **Other domains need three things from here.**
 *
 * 1. **To add a settings screen**, write `core/src/<domain>/<group>.config.ts`
 *    with `defineConfigGroup`, give every field a `.default()`, and add one
 *    import line to `system/config-groups.ts`. No route, no page, no migration:
 *    the generic screen reads the descriptor. A field marked `secret: true` is
 *    never read back — the screen shows an "is set" flag and an empty box.
 * 2. **To add a dashboard tile**, call `registerDashboardContributor` from your
 *    domain's `index.ts`. A contributor that throws degrades its own tiles and
 *    nothing else.
 * 3. **To add permission atoms**, `definePermissions` in your domain; they
 *    appear in the role editor and in `GET /admin-api/permissions` with no
 *    change here.
 *
 * Importing this module registers every config group and every dashboard
 * contributor there is, as a side effect. That is deliberate: a group nobody
 * imported cannot be edited. The groups arrive through `config.service.ts`,
 * which imports the gen'd `config-groups.gen.ts` bucket; the dashboard
 * contributors `system` owns are below.
 */
import { registerMapConfigTest } from './map.config-test';

import './dashboard-tiles';

export {
  adminCreate,
  adminDelete,
  adminDetail,
  adminList,
  adminResetPassword,
  adminSetStatus,
  adminUpdate,
  configureAdminPasswords,
  profileChangePassword,
  profileGet,
  profileUpdate,
} from './admin.service';

export {
  permissionTree,
  permissionTreeRoute,
  roleCreate,
  roleDelete,
  roleDetail,
  roleList,
  roleSetStatus,
  roleUpdate,
} from './role.service';

export {
  configGet,
  configGroupList,
  configSave,
  configTest,
  describeGroup,
} from './config.service';
export { agreementGet } from './agreement.service';
export { auditLogList, pruneAuditLogs } from './audit.service';
export { failedJobList, failedJobResolve } from './failed-jobs.service';

export {
  countTile,
  dashboardContributorKeys,
  dashboardHeader,
  registerDashboardContributor,
  resetDashboardContributors,
  type DashboardContributor,
} from './dashboard';
export { registerAttentionSource, type AttentionSource } from './dashboard-tiles';

export { systemPermissions } from './permissions';
export { AGREEMENT_FIELDS, agreementConfig } from './agreement.config';
export { logisticsConfig } from './logistics.config';
export { mapConfig } from './map.config';
/**
 * `publicOrigin` / `isTrustedHost` are the origin's one home. Any domain that
 * needs an absolute URL, or has to decide whether a host is ours, asks here
 * rather than keeping its own copy of the answer.
 */
export { isTrustedHost, publicOrigin, siteConfig } from './site.config';
/**
 * The site's public settings: the builders `GET /api/v1/app/config` is made
 * from (the old `GET /api/v1/site/config` route was deleted at the cutover).
 *
 * `registerSitePaymentMethod` is how a gateway says it is usable *without*
 * `system` importing it: this domain is a sink and must import none, or
 * `notification`'s effect handler registers itself under `undefined/undefined`
 * (see the comment in `site.service.ts`). `registerSiteAuthMethod` is the same
 * seam for the sign-in methods; `wechat` and `sms` register them.
 */
export {
  orNull,
  registerSiteAuthMethod,
  registerSitePaymentMethod,
  resetSiteAuthMethods,
  resetSitePaymentMethods,
  siteConfigSourceGroups,
  type SiteAuthMethod,
  type SiteAuthMethodSource,
  type SitePaymentMethod,
  type SitePaymentMethodSource,
} from './site.service';
/**
 * `GET /api/v1/app/config` — the mini-program's launch payload: the site's
 * public settings plus the theme, the tab bar and the subscribe-message
 * template ids. `registerAppConfigSource` is the same seam as
 * `registerSiteAuthMethod`, for the values `wechat-oa` and `user` own.
 */
export {
  appConfigGet,
  appConfigSourceGroups,
  appearanceOf,
  invalidateAppConfigCache,
  registerAppConfigSource,
  resetAppConfigSources,
  type AppConfigSources,
} from './app-config.service';
export {
  storefrontAppearanceConfig,
  type StorefrontAppearanceConfig,
} from './storefront-appearance.config';
export { smsConfig } from './sms.config';
export { wechatMiniConfig, type MiniCodeEnvVersion } from './wechat-mini.config';
export { wechatOaConfig } from './wechat-oa.config';
export * as systemRepo from './system.repo';

/**
 * Wires the tests on this domain's settings screens; called once per process
 * from the gen'd bootstrap.
 */
export function registerSystemDomain(): void {
  registerMapConfigTest();
}
