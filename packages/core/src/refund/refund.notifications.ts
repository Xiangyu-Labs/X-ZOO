import { registerNotificationEvents } from '../notification';

/**
 * The refund domain's own admin notification.
 *
 * Raised when a well-signed refund notification — or a query answer — does not
 * match the after-sale it names: another merchant, or an amount other than the
 * one frozen at creation. The refund is left where it was (never `succeeded`),
 * the reason is written to `refunds.last_error` and the refund's log, and the
 * operators who can open 退款单 are told.
 */
export const REFUND_EXCEPTION_EVENT = 'admin_refund_exception';

/** Idempotent: the registry accepts the same code twice with the same name. */
export function registerRefundNotificationEvents(): void {
  registerNotificationEvents([
    {
      code: REFUND_EXCEPTION_EVENT,
      name: '退款异常提醒',
      description:
        '退款通知或查询结果与退款单不符（商户号或金额）时提醒。退款单不会被记为成功，需人工核对',
      audience: 'admin',
      permission: 'refund:request:read',
      variables: ['refundId', 'refundNo', 'amount', 'reason'],
      channels: ['inApp'],
      defaults: { title: '退款异常待核对', body: '退款单 {{refundNo}}：{{reason}}。' },
      link: '/admin/trade/refunds?detail={{refundId}}',
    },
  ]);
}
