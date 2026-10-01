import type { NotificationChannel } from '@shop/contracts/notification/schemas';
import type { RefundKind } from '@shop/contracts/refund/schemas';
import { Money } from '../kernel/money';
import {
  storefrontRouteDef,
  storefrontRouteKey,
  type StorefrontRouteKey,
} from '@shop/contracts/system/storefront-routes';

/**
 * The registry of business events that produce a notification.
 *
 * **Codes are compiled in; only the wording and the switches are data.** An
 * operator-editable code would let a typo in the admin silently stop every send
 * of that event with no error anywhere. Here `notification_templates.code` is a
 * foreign key onto this table in spirit: a row whose code is not in the
 * registry is ignored, and a registry entry with no row is seeded on first
 * read.
 *
 * ## What is deliberately not here
 *
 * - SMS verification codes: the `sms` domain sends them, and they are not a
 *   business event.
 * - Events another domain owns the wording of: group buy, presale, payment
 *   and refund register their own entries with `registerNotificationEvents`
 *   from their `index.ts`.
 * - Same-city delivery and distribution/brokerage events: those features are
 *   out of scope.
 */

export type NotificationAudience = 'user' | 'admin';

export interface NotificationEvent {
  /** Stable key. Appears in `notification_templates.code` and in the effect's scope id. */
  code: string;
  name: string;
  description: string;
  audience: NotificationAudience;
  /**
   * Placeholders the event provides. Rendered from the effect payload; the
   * admin form lists them so an operator does not have to guess.
   */
  variables: readonly string[];
  /**
   * Channels this event may use at all.
   *
   * An admin event has no openid and no phone number we are entitled to text,
   * so it is in-app only. A user event can use all four.
   */
  channels: readonly NotificationChannel[];
  /**
   * For `audience: 'admin'`: the permission atom an admin must hold to receive
   * it. Fan-out resolves recipients by this, so the person who cannot open
   * 退款单 is not woken up by one.
   */
  permission?: string;
  /** Default in-app wording, used to seed the row the first time it is read. */
  defaults: { title: string; body: string };
  /**
   * Admin events only: the admin path the bell opens, `{{…}}` substituted like
   * the body. A customer event opens its `route` instead; the old H5 `link` on
   * customer events was deleted at the cutover, so a 公众号 template message
   * links only to the `linkUrl` an operator configured.
   */
  link?: string;
  /**
   * Where tapping the message goes in the mini program: a route-catalogue key
   * (one marked `notify`) and its params, each a `{{…}}` template
   * (docs/mini/pages.md §3.4). Rendered, then validated against the key's
   * params (`renderRoute`): the subscribe message's `page` is its `toMiniPath`,
   * and an in-app message stores it as `data.route`.
   */
  route?: NotificationRouteTemplate;
}

/** `{ route, params }` with `{{…}}` placeholders in the param values. */
export interface NotificationRouteTemplate {
  route: StorefrontRouteKey;
  params: Readonly<Record<string, string>>;
}

const USER_CHANNELS = ['inApp', 'wechatOa', 'wechatMini', 'sms'] as const;
const ADMIN_CHANNELS = ['inApp'] as const;

const registry = new Map<string, NotificationEvent>();

/**
 * Declares events. Idempotent per code: registering the same code twice with
 * the same name is free (a module reload in dev), with a different name throws.
 *
 * Other domains call this from their own `index.ts` (group buy, presale,
 * payment, refund), which is why it is exported rather than the table being a
 * frozen constant.
 */
export function registerNotificationEvents(events: readonly NotificationEvent[]): void {
  for (const event of events) {
    if (!/^[a-z][a-z0-9_]*$/.test(event.code)) {
      throw new Error(`notification event "${event.code}" 必须是小写下划线命名`);
    }
    const existing = registry.get(event.code);
    if (existing && existing.name !== event.name) {
      throw new Error(`notification event "${event.code}" 重复定义`);
    }
    if (event.audience === 'admin' && !event.permission) {
      throw new Error(`notification event "${event.code}" 是后台通知，必须声明 permission`);
    }
    if (event.audience === 'user' && event.link !== undefined) {
      throw new Error(`notification event "${event.code}" 是用户通知，用 route 而不是 link`);
    }
    if (event.route) {
      const key = storefrontRouteKey.safeParse(event.route.route);
      if (event.audience !== 'user' || !key.success || !storefrontRouteDef(key.data).notify) {
        throw new Error(`notification event "${event.code}" 的路由必须是可通知的商城路由`);
      }
    }
    registry.set(event.code, event);
  }
}

export function findNotificationEvent(code: string): NotificationEvent | undefined {
  return registry.get(code);
}

export function allNotificationEvents(): NotificationEvent[] {
  return [...registry.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Test helper. Never call this from app code. */
export function resetNotificationRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// the built-in events
// ---------------------------------------------------------------------------

/**
 * How 退款申请通过 and 退款到账 speak of the money (or, for a return, the goods). A refund may be worth ¥0 —
 * an order a coupon paid for in full gives back units, the coupon and the seat
 * — and 「¥0.00 已原路退回」 tells the buyer to look for money that is not coming.
 */
export function approvedRefundNote(amount: string, kind: RefundKind): string {
  // A return pays out only when the goods are back, so its approval asks for
  // them instead of promising money. The address is too long for a
  // subscribe-message `thing` (20 characters); the message opens 售后详情,
  // which shows the frozen address with a copy button.
  if (kind === 'return_and_refund') return '的商品请寄回，地址见售后详情';
  return isZeroAmount(amount) ? '没有需要退回的款项' : `的 ¥${amount} 将原路退回`;
}

export function settledRefundNote(amount: string): string {
  return isZeroAmount(amount) ? '已处理完成，没有需要退回的款项' : `的 ¥${amount} 已原路退回`;
}

function isZeroAmount(amount: string): boolean {
  return amount.trim() === '' || Money.parse(amount).isZero();
}

/**
 * What every order sender fills. The admin form lists these as the variables
 * an operator may use, so a name here that no sender supplies is a promise the
 * message breaks: `nickname` was listed for months and rendered blank.
 */
const ORDER_VARS = ['orderId', 'orderNo', 'amount'] as const;
/** 取消 and 完成 are announced from hooks that carry no amount. */
const ORDER_ID_VARS = ['orderId', 'orderNo'] as const;

/** The mini-program pages customer events open (docs/mini/pages.md §3.4). */
export const ORDER_ROUTE: NotificationRouteTemplate = {
  route: 'order',
  params: { id: '{{orderId}}' },
};
export const REFUND_ROUTE: NotificationRouteTemplate = {
  route: 'refund',
  params: { id: '{{refundId}}' },
};

/**
 * Registered from `notification/index.ts`, which the generated
 * `@shop/core/domains` bucket imports once per app. Safe to call twice.
 */
export function registerBuiltInNotificationEvents(): void {
  registerNotificationEvents([
    // -- user ---------------------------------------------------------------
    {
      code: 'order_created',
      name: '下单成功提醒',
      description: '买家提交订单后立即发送',
      audience: 'user',
      variables: [...ORDER_VARS],
      channels: [...USER_CHANNELS],
      defaults: { title: '订单提交成功', body: '订单 {{orderNo}} 已提交，应付 ¥{{amount}}。' },
      route: ORDER_ROUTE,
    },
    {
      code: 'order_paid',
      name: '支付成功提醒',
      description: '支付成功后发送给买家',
      audience: 'user',
      variables: [...ORDER_VARS, 'paidAt'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '支付成功',
        body: '订单 {{orderNo}} 已支付 ¥{{amount}}，我们会尽快发货。',
      },
      route: ORDER_ROUTE,
    },
    {
      code: 'order_shipped',
      name: '订单发货通知',
      description: '订单发货后通知买家，分批发货时每个包裹一条。虚拟商品自动发货也走这里',
      audience: 'user',
      // `company` / `trackingNo` are a courier's; `deliveryInfo` reads right for
      // 快递, 商家配送 and 虚拟发货 alike, so the default wording uses it.
      variables: [
        ...ORDER_VARS,
        'company',
        'trackingNo',
        'courierName',
        'courierPhone',
        'deliveryInfo',
      ],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '您的订单已发货',
        body: '订单 {{orderNo}} 已发货，{{deliveryInfo}}。',
      },
      route: ORDER_ROUTE,
    },
    {
      code: 'order_received',
      name: '确认收货提醒',
      description: '买家确认收货或系统自动收货后发送',
      audience: 'user',
      variables: [...ORDER_VARS],
      channels: [...USER_CHANNELS],
      defaults: { title: '确认收货成功', body: '订单 {{orderNo}} 已确认收货，感谢您的购买。' },
      route: ORDER_ROUTE,
    },
    {
      code: 'order_completed',
      name: '订单完成提醒',
      description: '订单结束后发送',
      audience: 'user',
      variables: [...ORDER_ID_VARS],
      channels: [...USER_CHANNELS],
      defaults: { title: '订单已完成', body: '订单 {{orderNo}} 已完成，期待再次为您服务。' },
      route: ORDER_ROUTE,
    },
    {
      code: 'order_cancelled',
      name: '订单取消提醒',
      description: '订单被取消（买家取消、超时未付款、后台取消）后发送',
      audience: 'user',
      variables: [...ORDER_ID_VARS, 'reason'],
      channels: [...USER_CHANNELS],
      defaults: { title: '订单已取消', body: '订单 {{orderNo}} 已取消。' },
      route: ORDER_ROUTE,
    },
    {
      code: 'order_price_changed',
      name: '订单改价提醒',
      description: '后台修改订单金额后通知买家',
      audience: 'user',
      variables: [...ORDER_VARS, 'oldAmount'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '订单金额已修改',
        body: '订单 {{orderNo}} 的金额由 ¥{{oldAmount}} 改为 ¥{{amount}}，请重新支付。',
      },
      route: ORDER_ROUTE,
    },
    {
      // Sent by `order.remindUnpaid`, `unpaidReminderMinutes` before the
      // payment window closes, and only while the order still awaits payment.
      code: 'order_unpaid_reminder',
      name: '未付款提醒',
      description: '订单即将超时取消前提醒买家付款，提前时间在订单设置中配置',
      audience: 'user',
      variables: [...ORDER_VARS, 'expiresAt'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '订单待付款',
        body: '订单 {{orderNo}} 还未付款，将于 {{expiresAt}} 自动取消，请尽快完成支付。',
      },
      route: ORDER_ROUTE,
    },
    {
      code: 'refund_applied',
      name: '退款申请已提交',
      description: '买家提交退款申请后的回执',
      audience: 'user',
      variables: ['refundId', 'refundNo', 'orderNo', 'amount'],
      channels: [...USER_CHANNELS],
      defaults: { title: '退款申请已提交', body: '退款单 {{refundNo}} 已提交，我们会尽快处理。' },
      route: REFUND_ROUTE,
    },
    {
      code: 'refund_approved',
      name: '退款申请通过',
      description: '客服同意退款后发送',
      audience: 'user',
      variables: ['refundId', 'refundNo', 'orderNo', 'amount', 'refundNote'],
      channels: [...USER_CHANNELS],
      defaults: {
        title: '退款申请已通过',
        body: '退款单 {{refundNo}} 已通过审核，订单 {{orderNo}} {{refundNote}}。',
      },
      route: REFUND_ROUTE,
    },
    {
      code: 'refund_rejected',
      name: '退款申请驳回',
      description: '客服拒绝退款后发送',
      audience: 'user',
      variables: ['refundId', 'refundNo', 'orderNo', 'reason'],
      channels: [...USER_CHANNELS],
      defaults: { title: '退款申请未通过', body: '退款单 {{refundNo}} 未通过审核：{{reason}}。' },
      route: REFUND_ROUTE,
    },
    {
      code: 'refund_settled',
      name: '退款到账提醒',
      description: '退款成功打回原支付渠道后发送',
      audience: 'user',
      variables: ['refundId', 'refundNo', 'orderNo', 'amount', 'refundNote'],
      channels: [...USER_CHANNELS],
      defaults: { title: '退款已完成', body: '退款单 {{refundNo}} {{refundNote}}。' },
      route: REFUND_ROUTE,
    },
    {
      // 内容安全 (C09): sent by the user domain's `onAvatarRejected`.
      code: 'user_avatar_rejected',
      name: '头像未通过审核提醒',
      description: '用户上传的头像未通过微信内容安全检测、已恢复为默认头像时发送',
      audience: 'user',
      variables: [],
      channels: ['inApp'],
      defaults: {
        title: '头像未通过审核',
        body: '您上传的头像未通过内容安全审核，已恢复为默认头像，请重新上传。',
      },
    },

    // -- admin --------------------------------------------------------------
    {
      code: 'admin_order_created',
      name: '新订单提醒',
      description: '有新订单提交时提醒有订单查看权限的管理员',
      audience: 'admin',
      permission: 'order:order:read',
      variables: [...ORDER_VARS],
      channels: [...ADMIN_CHANNELS],
      defaults: { title: '新订单', body: '订单 {{orderNo}} 已提交，金额 ¥{{amount}}。' },
      link: '/admin/orders/{{orderId}}',
    },
    {
      code: 'admin_order_paid',
      name: '新支付订单提醒',
      description: '有订单付款时提醒',
      audience: 'admin',
      permission: 'order:order:read',
      variables: [...ORDER_VARS],
      channels: [...ADMIN_CHANNELS],
      defaults: { title: '新的已付款订单', body: '订单 {{orderNo}} 已付款，金额 ¥{{amount}}。' },
      link: '/admin/orders/{{orderId}}',
    },
    {
      code: 'admin_order_received',
      name: '用户确认收货提醒',
      description: '买家确认收货时提醒',
      audience: 'admin',
      permission: 'order:order:read',
      variables: [...ORDER_VARS],
      channels: [...ADMIN_CHANNELS],
      defaults: { title: '用户已确认收货', body: '订单 {{orderNo}} 已由买家确认收货。' },
      link: '/admin/orders/{{orderId}}',
    },
    {
      code: 'admin_refund_applied',
      name: '用户申请退款提醒',
      description: '买家提交退款申请时提醒能处理售后的管理员',
      audience: 'admin',
      permission: 'refund:request:read',
      variables: ['refundId', 'refundNo', 'orderNo', 'amount', 'reason'],
      channels: [...ADMIN_CHANNELS],
      defaults: { title: '新的退款申请', body: '退款单 {{refundNo}} 待处理，金额 ¥{{amount}}。' },
      link: '/admin/trade/refunds?detail={{refundId}}',
    },
    {
      code: 'admin_low_stock',
      name: '库存预警',
      description: '商品库存低于预警值时提醒',
      audience: 'admin',
      permission: 'catalog:product:read',
      variables: ['productId', 'productName', 'stock', 'threshold'],
      channels: [...ADMIN_CHANNELS],
      defaults: {
        title: '库存预警',
        body: '{{productName}} 仅剩 {{stock}} 件，低于预警值 {{threshold}}。',
      },
      link: '/admin/catalog/products/{{productId}}',
    },
    {
      code: 'admin_payment_exception',
      name: '支付异常提醒',
      description: '出现需要人工核对的支付异常时提醒',
      audience: 'admin',
      permission: 'payment:exception:read',
      variables: ['exceptionId', 'outTradeNo', 'amount', 'reason'],
      channels: [...ADMIN_CHANNELS],
      defaults: { title: '支付异常待处理', body: '{{outTradeNo}}：{{reason}}。' },
      link: '/admin/trade/payment-exceptions?detail={{exceptionId}}',
    },
  ]);
}
