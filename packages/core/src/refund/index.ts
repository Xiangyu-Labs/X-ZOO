import { registerRefundEffects } from './refund.effects';
import { registerRefundNotificationEvents } from './refund.notifications';

/**
 * The refund domain's public surface.
 *
 * `docs/conventions.md`: a domain in `core` may import another domain only
 * through its `index.ts`. So this file is the contract between after-sales and
 * everybody else, and `refund.repo.ts` is private — nothing outside this folder
 * may write a `refunds` row.
 *
 * ## Direction of dependency
 *
 * `refund → payment`, never the other way. The refund domain is the one that
 * knows about `refunds` rows, so it owns the **refund webhook**
 * (`handleRefundNotify`) and hands anything it does not recognise back to
 * payment, whose exception refunds carry their own `X` numbers.
 *
 * ## What other domains call
 *
 * | Function                | Caller             | When                                   |
 * | ----------------------- | ------------------ | -------------------------------------- |
 * | `handleRefundNotify`    | route              | `POST /api/v1/webhooks/wechat-refund`  |
 * | `executeRefund`         | this domain only   | the effect handler and the admin retry |
 * | `reconcileStaleRefunds` | worker             | the sweep                              |
 * | `refundSystemInitiated` | group-buy, presale | a failed group buy, an expired presale |
 *
 * There is no "create a refund on behalf of a user" export, and there never
 * will be: `apply` needs a `ctx` whose actor is the buyer. What exists instead
 * is the other thing — a refund the **shop** owes without anybody asking, with
 * its own ceiling check and no approval step (`refund.system.service.ts`).
 * Nothing may insert a `refunds` row by reaching past this file.
 */

// `detail` (any after-sale by id, no ownership check) is deliberately not here:
// the storefront reads through `myDetail`, the admin through `adminDetail`, and
// in-domain callers import it from `./refund.service`.
export {
  applicableItems,
  apply,
  cancel,
  executeRefund,
  handleRefundNotify,
  hide,
  myDetail,
  myList,
  reconcileRefund,
  refundReasons,
  settleRefundSucceeded,
  submitReturnShipment,
  REFUND_REASONS,
  type ExecuteResult,
} from './refund.service';

export {
  adminApprove,
  adminDetail,
  adminList,
  adminReceiveReturn,
  adminReject,
  adminRemark,
  adminRetry,
} from './refund.admin';

export {
  refundSystemInitiated,
  type SystemRefundInput,
  type SystemRefundReason,
  type SystemRefundResult,
} from './refund.system.service';

export {
  reconcileStaleRefunds,
  type RefundSweepOptions,
  type RefundSweepReport,
} from './refund.jobs';

export { refundConfig, returnAddress, type RefundConfig } from './refund.config';
// Which refunds hold a line's units (REFUND-015): the rule `refunded_quantity`
// is derived by, for readers that check it (the SEQ-001 sequence).
export { countsUnits, IN_FLIGHT_STATUSES } from './refund.rules';
export { refundPermissions } from './permissions';
export { registerRefundEffects } from './refund.effects';
export { REFUND_EXCEPTION_EVENT, registerRefundNotificationEvents } from './refund.notifications';

/**
 * Wires the domain into the platform. Called once per process from the gen'd
 * bootstrap; kept separate from definition so a unit test can import a service
 * without acquiring a global handler.
 */
export function registerRefundDomain(): void {
  registerRefundEffects();
  // A gateway answer that does not match the refund (wrong merchant, wrong
  // amount) is raised to an operator.
  registerRefundNotificationEvents();
}
