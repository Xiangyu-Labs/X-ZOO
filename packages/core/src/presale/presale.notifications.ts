import { Money } from '../kernel/money';
import { registerNotificationEvents, type NotificationRouteTemplate } from '../notification';

/**
 * What a presale shopper is told, and when.
 *
 * | code               | sent by                   | when                                           |
 * | ------------------ | ------------------------- | ---------------------------------------------- |
 * | `presale_paid`     | the `presale.paid` effect | the order is paid and its ship date is fixed   |
 * | `presale_sold_out` | the `presale.refund` one  | the campaign's quota filled while it was paid  |
 *
 * Presale is full payment only (a deposit campaign is refused at creation), so
 * there is no 尾款 to remind anybody of. Shipping, cancelling and an ordinary
 * refund are the order domain's own notices and reach a presale order like any
 * other; the one thing only presale knows is the promise — "not before this
 * day" — and that is what `presale_paid` says.
 *
 * `presale_sold_out` is recorded in the transaction that opens the automatic
 * refund, so it exists exactly when the refund does.
 *
 * In the mini program (`route`, docs/mini/pages.md §3.4) the paid notice
 * opens the order and the sold-out one the automatic refund.
 */

export const PRESALE_EVENTS = {
  paid: 'presale_paid',
  soldOut: 'presale_sold_out',
} as const;

const USER_CHANNELS = ['inApp', 'wechatOa', 'wechatMini', 'sms'] as const;
const ORDER_ROUTE: NotificationRouteTemplate = { route: 'order', params: { id: '{{orderId}}' } };
const REFUND_ROUTE: NotificationRouteTemplate = {
  route: 'refund',
  params: { id: '{{refundId}}' },
};

/** Idempotent: the registry accepts the same code twice with the same name. */
export function registerPresaleNotificationEvents(): void {
  registerNotificationEvents([
    {
      code: PRESALE_EVENTS.paid,
      name: '预售付款成功提醒',
      description: '预售订单付款后发送，告知最早发货日期',
      audience: 'user',
      variables: ['orderId', 'orderNo', 'activityTitle', 'amount', 'shipDate'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '预售付款成功',
        body: '您预订的「{{activityTitle}}」已付款 ¥{{amount}}，将于 {{shipDate}} 起发货。',
      },
      route: ORDER_ROUTE,
    },
    {
      code: PRESALE_EVENTS.soldOut,
      name: '预售名额已满退款提醒',
      description: '付款时预售限购总量恰好已满、系统发起自动退款时发送',
      audience: 'user',
      variables: ['orderId', 'orderNo', 'activityTitle', 'amount', 'refundNote', 'refundId'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '预售名额已满',
        body: '「{{activityTitle}}」的预售名额已满，订单 {{orderNo}} {{refundNote}}。',
      },
      route: REFUND_ROUTE,
    },
  ]);
}

/**
 * How the notice speaks of the money: 「的 ¥59.00 将原路退回」, and for an order
 * that cost the shopper nothing 「已关闭，没有产生扣款」 rather than a ¥0.00 refund.
 */
export function refundNoteOf(paidAmount: string | null): string {
  if (paidAmount === null || Money.parse(paidAmount).isZero()) return '已关闭，没有产生扣款';
  return `的 ¥${paidAmount} 将原路退回`;
}
