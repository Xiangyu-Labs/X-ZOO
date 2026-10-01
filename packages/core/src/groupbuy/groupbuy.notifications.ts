import { Money } from '../kernel/money';
import { registerNotificationEvents, type NotificationRouteTemplate } from '../notification';

/**
 * What a group-buy shopper is told, and when.
 *
 * | code                 | sent by                         | to                          |
 * | -------------------- | ------------------------------- | --------------------------- |
 * | `groupbuy_created`   | the `groupbuy.join` effect      | a leader whose seat is paid |
 * | `groupbuy_joined`    | the `groupbuy.join` effect      | a member whose seat is paid |
 * | `groupbuy_succeeded` | the `groupbuy.settle` effect    | every paid member           |
 * | `groupbuy_failed`    | the `groupbuy.refund` effect    | each member being refunded  |
 *
 * The codes are the ones the reference-data seed already writes shells for, so
 * 通知管理 shows one row per event rather than a seeded row nobody sends and a
 * registered one beside it.
 *
 * `groupbuy_failed` is sent by the refund, not by the settle: a shopper whose
 * team failed is told in the same transaction that opens their refund, so the
 * message can say the money is on its way and never arrives for a refund that
 * rolled back. It also covers the shopper who paid for a seat somebody else took
 * a moment earlier, whose team did not fail at all but who is owed the same
 * news.
 */

export const GROUPBUY_EVENTS = {
  created: 'groupbuy_created',
  joined: 'groupbuy_joined',
  succeeded: 'groupbuy_succeeded',
  failed: 'groupbuy_failed',
} as const;

const TEAM_VARS = [
  'orderId',
  'orderNo',
  'groupId',
  'activityTitle',
  'seatsTotal',
  'seatsLeft',
  'expiresAt',
] as const;

const USER_CHANNELS = ['inApp', 'wechatOa', 'wechatMini', 'sms'] as const;

/** The mini-program pages (docs/mini/pages.md §3.4). */
const TEAM_ROUTE: NotificationRouteTemplate = {
  route: 'groupbuyTeam',
  params: { id: '{{groupId}}' },
};
/** A failed team is refunded automatically: the refund is what to look at. */
const REFUND_ROUTE: NotificationRouteTemplate = {
  route: 'refund',
  params: { id: '{{refundId}}' },
};

/** Idempotent: the registry accepts the same code twice with the same name. */
export function registerGroupbuyNotificationEvents(): void {
  registerNotificationEvents([
    {
      code: GROUPBUY_EVENTS.created,
      name: '开团成功提醒',
      description: '团长付款、拼团开始后发送',
      audience: 'user',
      variables: [...TEAM_VARS],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '开团成功',
        body: '「{{activityTitle}}」开团成功，{{seatsTotal}} 人成团，请在 {{expiresAt}} 前邀请好友参团。',
      },
      route: TEAM_ROUTE,
    },
    {
      code: GROUPBUY_EVENTS.joined,
      name: '参团成功提醒',
      description: '参团付款、占到名额后发送',
      audience: 'user',
      variables: [...TEAM_VARS],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '参团成功',
        body: '您已加入「{{activityTitle}}」的拼团，成团后我们会尽快发货。',
      },
      route: TEAM_ROUTE,
    },
    {
      code: GROUPBUY_EVENTS.succeeded,
      name: '拼团成功提醒',
      description: '拼团人满（含虚拟成团、后台立即成团）后发送给每位已付款的成员',
      audience: 'user',
      variables: ['orderId', 'orderNo', 'groupId', 'activityTitle', 'seatsTotal'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '拼团成功',
        body: '「{{activityTitle}}」拼团成功，订单 {{orderNo}} 将尽快为您发货。',
      },
      route: TEAM_ROUTE,
    },
    {
      code: GROUPBUY_EVENTS.failed,
      name: '拼团失败提醒',
      description: '拼团失败或名额已被占满、系统发起自动退款时发送',
      audience: 'user',
      variables: [
        'orderId',
        'orderNo',
        'groupId',
        'activityTitle',
        'amount',
        'refundNote',
        'reason',
        'refundId',
      ],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '拼团失败',
        body: '「{{activityTitle}}」{{reason}}，订单 {{orderNo}} {{refundNote}}。',
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
