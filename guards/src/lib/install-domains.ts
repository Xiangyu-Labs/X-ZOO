/**
 * Side-effect import: installs every domain, exactly the way `handle.ts` and the
 * worker container do, so the guards see the same permission atoms, config
 * groups, ports and effect handlers a running process sees.
 *
 * `@shop/core/system` is imported as well because the config-group bucket is
 * pulled in by `system/config.service.ts`, not by `domains.gen.ts`: a guard that
 * imported only the domains would walk a fraction of the config groups and
 * would cheerfully declare the secrets check green.
 */
import '@shop/core/domains';
// Every domain by name, as a bare side-effect import. esbuild elides a
// namespace import whose binding is unused (`import * as x from './x/index'`),
// so `domains.gen.ts` imports every domain bare and the `domains` check fails
// if it ever relies on a namespace import alone. Importing each domain here as
// well means the guards cannot inherit the bug they exist to report.
import '@shop/core/auth';
import '@shop/core/cart';
import '@shop/core/catalog';
import '@shop/core/cms';
import '@shop/core/coupon';
import '@shop/core/decor';
import '@shop/core/effects';
import '@shop/core/groupbuy';
import '@shop/core/notification';
import '@shop/core/order';
import '@shop/core/payment';
import '@shop/core/presale';
import '@shop/core/refund';
import '@shop/core/shipping';
import '@shop/core/sms';
import '@shop/core/stats';
import '@shop/core/storage';
import '@shop/core/system';
import '@shop/core/user';
import '@shop/core/wechat';
import '@shop/core/wechat-oa';

/**
 * The same list as data, so `checks/domains.ts` can compare it against
 * `DOMAIN_NAMES` and fail when a new domain lands without being added here.
 */
export const INSTALLED_DOMAINS = [
  'auth',
  'cart',
  'catalog',
  'cms',
  'coupon',
  'decor',
  'effects',
  'groupbuy',
  'notification',
  'order',
  'payment',
  'presale',
  'refund',
  'shipping',
  'sms',
  'stats',
  'storage',
  'system',
  'user',
  'wechat',
  'wechat-oa',
] as const;
