/**
 * The presale domain's public surface.
 *
 * A domain in `core` may import another domain only through that domain's
 * `index.ts`, so this file is the boundary, and `presale.repo.ts` in particular
 * is private — nothing outside this folder may read a `presale_*` table.
 *
 * Almost nothing here is called by another domain. Presale does not *ask* for
 * anything: it attaches to the order aggregate through the seams in
 * `order/ports.ts` and is invoked, never invoking. The exceptions are the
 * window sweep the worker runs and, in the other direction, the two calls this
 * domain makes into others — `refund.refundSystemInitiated`, for a payment the
 * campaign could not honour, and `notification.notify`, for telling the
 * shopper.
 */

export {
  adminActivityCreate,
  adminActivityDelete,
  adminActivityDetail,
  adminActivityList,
  adminActivitySetStatus,
  adminActivityUpdate,
  cardsFor,
  adminOrderList,
  detail,
  list,
} from './presale.service';

export {
  closeEndedActivities,
  recordOpenedActivities,
  sweepPresaleWindows,
  PRESALE_WINDOW_JOB,
  type WindowSweepReport,
} from './presale.jobs';

export { presaleConfig, type PresaleConfig } from './presale.config';
export { presalePermissions } from './permissions';

/** Exported for the order-seam tests and for nothing else. */
export { presaleKindHandler, presalePricingContributor } from './presale.order';

/**
 * The refund seam. It forwards to `refund.refundSystemInitiated` by default —
 * registering anything else is a test substituting a spy, not a configuration
 * point.
 */
export {
  clearAutoRefundPort,
  registerAutoRefundPort,
  type AutoRefundPort,
} from './presale.effects';

import { registerPresaleEffects } from './presale.effects';
import { registerPresaleNotificationEvents } from './presale.notifications';
import { registerPresaleOrderSeams } from './presale.order';
import './presale.config';

/**
 * Wires the domain into the platform: the order kind handler, the pricing
 * contributor, the three lifecycle hooks, the five effect handlers and the two
 * shopper notifications.
 *
 * Idempotent — every registry replaces by name — so the web bootstrap and a
 * worker job module in the same process may both call it.
 */
export function registerPresaleDomain(): void {
  registerPresaleOrderSeams();
  registerPresaleEffects();
  registerPresaleNotificationEvents();
}

// Importing this module registers the domain. Nothing in `core` depends on
// presale, so without this line a process that only ever reaches the routes
// would have the config group but not the hooks — and an order would be paid
// with nobody to commit the campaign's sale.
registerPresaleDomain();
