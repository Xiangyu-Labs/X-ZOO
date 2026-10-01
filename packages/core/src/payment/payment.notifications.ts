import { registerNotificationEvents } from '../notification';

/**
 * The payment domain's own admin notification.
 *
 * `admin_payment_exception` covers money we received and cannot book — it
 * points at a `payment_exceptions` row, which carries an automatic refund. A
 * notification naming another merchant is a different thing: the money is not
 * ours to book *or* to refund (a refund would go out under our merchant id for
 * a transaction we never collected), so it gets no row and no refund, only this
 * message and the callback row's `result`. An operator reads the callback and
 * the merchant platform, and decides.
 */
export const PAYMENT_NOTIFY_MISMATCH_EVENT = 'admin_payment_notify_mismatch';

/** Idempotent: the registry accepts the same code twice with the same name. */
export function registerPaymentNotificationEvents(): void {
  registerNotificationEvents([
    {
      code: PAYMENT_NOTIFY_MISMATCH_EVENT,
      name: '支付通知商户号不符',
      description:
        '收到签名有效、但商户号不是本店的支付通知时提醒。该通知未入账、未退款，需人工核对',
      audience: 'admin',
      permission: 'payment:exception:read',
      variables: ['outTradeNo', 'transactionId', 'mchId', 'expectedMchId'],
      channels: ['inApp'],
      defaults: {
        title: '支付通知商户号不符',
        body: '{{outTradeNo}} 的支付通知来自商户号 {{mchId}}（本店 {{expectedMchId}}），未入账，请核对。',
      },
    },
  ]);
}
