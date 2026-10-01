/**
 * The group-buy domain's public surface.
 *
 * A domain in `core` may import another domain only through that domain's
 * `index.ts`, so this file is the boundary, and `groupbuy.repo.ts` in
 * particular is private — nothing outside this folder may read a `groupbuy_*`
 * table.
 *
 * Almost nothing here is called by another domain. Group buy does not *ask* for
 * anything: it attaches to the order aggregate through the seams in
 * `order/ports.ts` and is invoked, never invoking. The exceptions are the two
 * jobs the worker runs and, in the other direction, the two calls this domain
 * makes into others — `refund.refundSystemInitiated`, for the money a failed
 * team owes back, and `notification.notify`, for telling the shopper.
 */

export {
  adminActivityCreate,
  adminActivityDelete,
  adminActivityDetail,
  adminActivityList,
  adminActivityOrders,
  adminActivitySetStatus,
  adminActivityUpdate,
  cardsFor,
  adminGroupComplete,
  adminGroupDetail,
  adminGroupList,
  adminStatistics,
  banners,
  detail,
  groupDetail,
  list,
  myGroups,
  openGroups,
  poster,
  summary,
  withdraw,
} from './groupbuy.service';

export {
  closeEndedActivities,
  settleExpiredGroups,
  settleGroup,
  type SettleResult,
  type SweepReport,
} from './groupbuy.jobs';

export { groupbuyConfig, type GroupbuyConfig } from './groupbuy.config';
export { groupbuyPermissions } from './permissions';

/**
 * The refund seam. It forwards to `refund.refundSystemInitiated` by default —
 * registering anything else is a test substituting a spy, not a configuration
 * point.
 */
export {
  clearAutoRefundPort,
  registerAutoRefundPort,
  type AutoRefundPort,
} from './groupbuy.effects';

/** Exported for the order-seam tests and for nothing else. */
export { groupbuyKindHandler, groupbuyPricingContributor } from './groupbuy.order';

import { onAccountCancelled } from '../user';
import { registerGroupbuyEffects } from './groupbuy.effects';
import { forgetMemberIdentity } from './groupbuy.service';
import { registerGroupbuyNotificationEvents } from './groupbuy.notifications';
import { registerGroupbuyOrderSeams } from './groupbuy.order';
import './groupbuy.config';

/**
 * Wires the domain into the platform: the order kind handler, the pricing
 * contributor, the three lifecycle hooks, the four effect handlers and the four
 * shopper notifications.
 *
 * Idempotent — every registry replaces by name — so the web bootstrap and a
 * worker job module in the same process may both call it.
 */
export function registerGroupbuyDomain(): void {
  registerGroupbuyOrderSeams();
  registerGroupbuyEffects();
  registerGroupbuyNotificationEvents();
  // 注销: a cancelled shopper's team seats stay, without their name or face.
  onAccountCancelled('groupbuy', forgetMemberIdentity);
}

// Importing this module registers the domain. Nothing in `core` depends on
// group buy, so without this line a process that only ever reaches the routes
// would have the config group but not the hooks — and an order would be paid
// with nobody to take the seat.
registerGroupbuyDomain();
