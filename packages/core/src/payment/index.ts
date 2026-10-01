import { registerPaymentPort } from '../order/ports';
import { registerAttentionSource, registerSitePaymentMethod } from '../system';
import { isPaymentEnabled, paymentConfig } from './payment.config';
import { countExceptionsAwaitingAction } from './payment.admin';
import { registerPaymentConfigTest } from './payment.config-test';
import {
  installMiniTradeHooks,
  registerMiniTradeEffects,
  registerMiniTradeNotificationEvents,
} from './payment.mini-trade';
import { registerPaymentEffects } from './payment.effects';
import { registerPaymentNotificationEvents } from './payment.notifications';
import { closeOrderPayments, ensureNoOpenAttempts, settleZeroAmountOrder } from './payment.service';

/**
 * The payment domain's public surface.
 *
 * `docs/conventions.md`: a domain in `core` may import another domain only
 * through its `index.ts`. So this file is the contract between payment and
 * everybody else, and `payment.repo.ts` in particular is private — nothing
 * outside this folder may write a `payment_attempts` row.
 *
 * ## What other domains call
 *
 * | Function                | Caller | When                                            |
 * | ----------------------- | ------ | ----------------------------------------------- |
 * | `closeOrderPayments`    | order  | **before** cancelling an order, outside the tx  |
 * | `ensureNoOpenAttempts`  | order  | inside the cancelling transaction (the port)    |
 * | `settlePayment`         | itself | the one place money becomes state               |
 * | `payClient`             | refund | the gateway client, already configured          |
 * | `recordCallback`        | refund | the refund webhook's idempotency insert         |
 * | `applyExceptionRefundNotification` | refund | a refund notification with an `X` number |
 *
 * The cancel path is two calls, not one, and the order matters. The port may
 * not make a network call — it runs inside a transaction with the order row
 * locked — so it can only report what the database already knows. The order
 * domain therefore calls `closeOrderPayments(ctx, orderId)` first, outside the
 * transaction, and only proceeds to cancel if it answered `closed`. `paid`
 * means the money arrived and the order is now paid; `unknown` means the
 * gateway did not answer, and **nothing may be released** — not stock, not the
 * coupon (QUEUE-003 / QUEUE-004).
 */

export {
  ackOrThrow,
  applyExceptionRefundNotification,
  closeOrderPayments,
  ensureNoOpenAttempts,
  handleTransactionNotify,
  payClient,
  paymentRuntime,
  paymentStatus,
  reconcileAttempt,
  recheckException,
  refundException,
  settlePayment,
  start,
  startPayment,
  type PaymentRuntime,
  type PaymentState,
  type SettlementFacts,
  type SettlementOutcome,
  type StartPaymentInput,
  type WebhookResult,
} from './payment.service';

export {
  adminExceptionDetail,
  adminFlowSummary,
  adminIgnoreException,
  adminListAttempts,
  adminListEffects,
  adminListExceptions,
  adminListFlows,
  adminRecheckException,
  adminRefundException,
  adminRetryEffect,
} from './payment.admin';

export {
  closeExpiredPayments,
  recheckExceptionRefunds,
  reconcileStalePayments,
  type SweepOptions,
  type SweepReport,
} from './payment.jobs';

export {
  NOTIFY_PATHS,
  isPaymentEnabled,
  paymentConfig,
  paymentCredentials,
  type PaymentConfig,
} from './payment.config';
export { paymentPermissions } from './permissions';
export {
  CORRECT_SHIPPING,
  MINI_TRADE_MANAGED_EVENT,
  MSG_JUMP_PATH,
  SHIPPING_BLOCKED_EVENT,
  SHIPPING_OVERDUE_EVENT,
  UPLOAD_SHIPPING,
  installMiniTradeHooks,
  miniTradeStatus,
  syncMiniTrade,
  wechatReceipt,
} from './payment.mini-trade';
export { miniTradeConfig, type MiniTradeConfig } from './payment.mini-trade.config';
export { findTradeOrderByOrder as findWechatTradeOrder } from './payment.mini-trade.repo';
export { registerPaymentEffects } from './payment.effects';
export {
  PAYMENT_NOTIFY_MISMATCH_EVENT,
  registerPaymentNotificationEvents,
} from './payment.notifications';

/**
 * The refund domain needs exactly two things from payment's tables: the
 * attempt a refund goes back through, and the callback ledger that makes a
 * replayed refund notification a no-op. Both are re-exported rather than
 * reached for.
 */
export {
  findAttempt as findPaymentAttempt,
  findAttemptByOutTradeNo as findPaymentAttemptByOutTradeNo,
  findPaidAttempt as findPaidPaymentAttempt,
  insertCallback as recordCallback,
  insertCapitalFlow as recordCapitalFlow,
  markCallbackProcessed,
  type AttemptRow as PaymentAttemptRow,
} from './payment.repo';

/**
 * Wires the domain into the platform.
 *
 * Called once per process from the gen'd bootstrap. Registration is separate
 * from definition so a unit test can import a service without acquiring a
 * global port, and so `resetOrderPorts()` in a test can put it back.
 */
export function registerPaymentDomain(): void {
  registerPaymentConfigTest();
  registerPaymentPort({ ensureNoOpenAttempts, closeOrderPayments, settleZeroAmountOrder });
  registerPaymentEffects();
  // 小程序发货信息管理 (C07): report shipments of mini-program payments, and
  // act on WeChat's settlement pushes.
  installMiniTradeHooks();
  registerMiniTradeEffects();
  registerMiniTradeNotificationEvents();
  // A notification naming another merchant is told to an operator.
  registerPaymentNotificationEvents();
  // Money 异常支付 holds is counted in 「异常待处理」 on the home page (rule 9).
  registerAttentionSource({
    key: 'payment.exceptions',
    label: '异常支付',
    href: '/admin/trade/payment-exceptions',
    atom: 'payment:exception:handle',
    order: 10,
    count: countExceptionsAwaitingAction,
  });
  // `GET /api/v1/app/config` tells the app which pay buttons to draw. It is
  // announced from here, not read from there: `system` is the domain every
  // other one imports, so an edge back into `payment` would be a cycle — one
  // that breaks `notification`'s effect handler registration. A boolean crosses
  // the seam, never a credential.
  registerSitePaymentMethod('wechat', { group: paymentConfig.group, isEnabled: isPaymentEnabled });
}
