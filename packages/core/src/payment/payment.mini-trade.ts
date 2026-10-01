import { toMiniPath } from '@shop/contracts/system/storefront-routes';
import type {
  MiniTradeStatus,
  WechatReceiptResult,
} from '@shop/contracts/payment/payment.mini-trade.contract';
import type { Tx } from '@shop/db';
import { requirePermission } from '../auth/rbac';
import { findEffect, recordEffect, registerEffectHandler, type Effect } from '../effects';
import type { Ctx } from '../kernel/context';
import { SummarizedError, UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { notify, registerNotificationEvents } from '../notification';
import {
  receiveOrder,
  registerWechatReceiptVerifier,
  requireOwnOrder,
  shipmentReportFacts,
  type ShipmentReportFacts,
} from '../order';
import {
  onShipmentDispatched,
  onShipmentUpdated,
  type ShipmentDispatchedEvent,
  type ShipmentUpdatedEvent,
} from '../order/ports';
import {
  describeItems,
  isShunfeng,
  maskPhone,
  MINI_PUSH_SCOPE,
  miniShippingPort,
  wechatConfig,
  wechatRefusal,
  type MiniLogisticsType,
  type MiniShippingPackage,
  type MiniUploadShipping,
} from '../wechat';
import { miniTradeConfig } from './payment.mini-trade.config';
import * as tradeRepo from './payment.mini-trade.repo';
import { paymentPermissions } from './permissions';
import * as repo from './payment.repo';

/**
 * 小程序发货信息管理 (C07), the payment domain's half.
 *
 * WeChat files shipping and receipt under the *payment*, not under our order,
 * and a managed mini program's money stays frozen until both are reported. So
 * this lives with the payments: it knows which order was paid through the
 * mini program, with which `transaction_id` and which payer openid.
 *
 * ## Who does what
 *
 * | When                                | What                                                                 |
 * | ----------------------------------- | -------------------------------------------------------------------- |
 * | a shipment is dispatched (in its tx) | `onShipmentDispatched` records `wechat.uploadShipping` — mini-program payments only, and only while 录入发货信息 is on |
 * | after commit, with retries          | the effect calls `upload_shipping_info` and stamps `wechat_trade_orders` |
 * | 修改发货信息 (in its tx)             | `onShipmentUpdated` records `wechat.correctShipping` — once per shipment, which is WeChat's own limit |
 * | WeChat pushes `trade_manage_*`      | the push handlers below (recorded by `wechat.mini-push.ts`)          |
 * | the client opens 确认收货 component  | `wechatReceipt` hands it the payment number for the shopper's own order |
 * | `{ via: 'wechat-component' }`       | the verifier asks `get_order` before the order moves                |
 *
 * ## Split shipments (WeChat's rules)
 *
 * - One shipment that sends everything: `delivery_mode = 1` (统一发货), any
 *   `logistics_type`.
 * - Several: `delivery_mode = 2` (分拆发货), one upload per shipment, the last
 *   with `is_all_delivered: true`. WeChat accepts 分拆 only for 快递
 *   (`10060006` otherwise), so a *part* that is a virtual or merchant delivery
 *   is not reported on its own — the express parts carry the order. The
 *   decision is frozen into the effect's payload when the shipment is
 *   dispatched, so a later shipment cannot rewrite what this one was.
 * - Several, none of them express: nothing could go out part by part, so the
 *   last part reports the whole order once, as 统一发货 (`wholeOrder`).
 * - Express parts already reported and a last part that is not express:
 *   WeChat will take nothing more, and the order would never be 全部发货. That
 *   is an operator's job in the 小程序后台, and they are told at dispatch
 *   (`admin_wechat_shipping_blocked`), as they are when an upload waits on
 *   something only they can fix (a carrier without 微信快递编码).
 * - Parts are reported in dispatch order: an upload waits (the effect retries)
 *   while an earlier shipment's upload is still pending, because WeChat takes
 *   nothing after `is_all_delivered`.
 */

export const UPLOAD_SHIPPING = 'wechat.uploadShipping';
export const CORRECT_SHIPPING = 'wechat.correctShipping';

/** `trade_manage_remind_shipping`: WeChat's 48-hour 未发货 reminder, as an admin notice. */
export const SHIPPING_OVERDUE_EVENT = 'admin_shipping_overdue';
/** `trade_manage_remind_access_api`: the mini program was put under 发货信息管理. */
export const MINI_TRADE_MANAGED_EVENT = 'admin_mini_trade_managed';
/** A shipment WeChat cannot be told about without an operator (WXSHIP-009). */
export const SHIPPING_BLOCKED_EVENT = 'admin_wechat_shipping_blocked';

/**
 * Where WeChat's 发货 / 结算 messages open: the catalogue's `order` page, found
 * by the payment's `out_trade_no`, which WeChat substitutes for `${商品订单号}`
 * (C07).
 *
 * The path comes from `toMiniPath`, so it moves with the catalogue. WeChat's
 * placeholder is not a valid `outTradeNo` (the route would refuse it), so the
 * route is built with a sentinel that is one, and the placeholder replaces the
 * sentinel only after the route has been validated and rendered.
 */
const OUT_TRADE_NO_SENTINEL = 'WECHATOUTTRADENOSENTINEL';
export const MSG_JUMP_PATH = msgJumpPath();

function msgJumpPath(): string {
  const path = toMiniPath({ route: 'order', params: { outTradeNo: OUT_TRADE_NO_SENTINEL } });
  if (!path.includes(OUT_TRADE_NO_SENTINEL)) throw new Error('order route lost its outTradeNo');
  return path.replace(OUT_TRADE_NO_SENTINEL, '${商品订单号}');
}

interface UploadPayload {
  orderId: number;
  shipmentId: number;
  deliveryMode: 1 | 2;
  isAllDelivered: boolean;
  /**
   * The last part of a split delivery none of whose parts were express: this
   * upload describes every live shipment of the order, as one 统一发货.
   */
  wholeOrder?: boolean;
}

/**
 * An upload that cannot go out until an operator fixes something. Thrown, so
 * the ledger keeps retrying (and parks it where the 待处理任务 console shows
 * it), and announced once per shipment so nobody has to find it there first.
 */
class ShippingBlocked extends SummarizedError {
  /** The reason is already written for the operator, so it is its own summary. */
  constructor(reason: string) {
    super(reason, reason);
  }
}

const uploadKey = (shipmentId: number) => ({
  scope: 'shipment',
  scopeId: String(shipmentId),
  eventType: UPLOAD_SHIPPING,
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Idempotent; called from `registerPaymentDomain()` and by tests that reset the ports. */
export function installMiniTradeHooks(): void {
  onShipmentDispatched.register('payment:wechat-shipping', recordUpload);
  onShipmentUpdated.register('payment:wechat-shipping-correction', recordCorrection);
  registerWechatReceiptVerifier({ verify: verifyReceipt });
}

export function registerMiniTradeEffects(): void {
  registerEffectHandler('shipment', UPLOAD_SHIPPING, uploadShipping);
  registerEffectHandler('shipment', CORRECT_SHIPPING, correctShipping);
  registerEffectHandler(MINI_PUSH_SCOPE, 'trade_manage_order_settlement', onSettlement);
  registerEffectHandler(MINI_PUSH_SCOPE, 'trade_manage_remind_shipping', onRemindShipping);
  registerEffectHandler(MINI_PUSH_SCOPE, 'trade_manage_remind_access_api', onManaged);
}

export function registerMiniTradeNotificationEvents(): void {
  registerNotificationEvents([
    {
      code: SHIPPING_OVERDUE_EVENT,
      name: '小程序订单超时未发货',
      description: '微信提醒：小程序支付的订单付款超过 48 小时仍未发货（发货信息管理）',
      audience: 'admin',
      permission: 'order:shipment:write',
      variables: ['orderId', 'orderNo', 'outTradeNo'],
      channels: ['inApp'],
      defaults: {
        title: '小程序订单超时未发货',
        body: '订单 {{orderNo}} 付款已超过 48 小时仍未发货，微信已提醒，请尽快发货。',
      },
      link: '/admin/orders/{{orderId}}',
    },
    {
      code: SHIPPING_BLOCKED_EVENT,
      name: '小程序发货信息未能录入微信',
      description:
        '小程序支付订单的发货信息无法自动录入微信（快递公司缺少微信快递编码、分拆发货的最后一个包裹不是快递等），需要处理，否则货款会被冻结',
      audience: 'admin',
      permission: 'order:shipment:write',
      variables: ['orderId', 'orderNo', 'reason'],
      channels: ['inApp'],
      defaults: {
        title: '小程序发货信息未能录入微信',
        body: '订单 {{orderNo}} 的发货信息未能自动录入微信：{{reason}}。录入前这笔货款会被微信冻结。',
      },
      link: '/admin/orders/{{orderId}}',
    },
    {
      code: MINI_TRADE_MANAGED_EVENT,
      name: '小程序已纳入发货信息管理',
      description: '微信通知：小程序已被纳入发货信息管理，小程序支付的货款将在确认收货后结算',
      audience: 'admin',
      permission: 'payment:config:write',
      variables: [],
      channels: ['inApp'],
      defaults: {
        title: '小程序已纳入发货信息管理',
        body: '小程序支付的货款在录入发货信息并确认收货后才会结算。请在「小程序发货信息管理」中确认已开启录入发货信息并完成同步。',
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// in the shipment's transaction
// ---------------------------------------------------------------------------

async function recordUpload(tx: Tx, ctx: Ctx, event: ShipmentDispatchedEvent): Promise<void> {
  const attempt = await repo.findPaidAttempt(tx, event.orderId);
  if (!attempt || attempt.channel !== 'wechat_mini') return;
  const { uploadEnabled } = await ctx.config.getIn(tx, miniTradeConfig);
  if (!uploadEnabled) return;

  let reportedBefore = false;
  for (const other of event.otherShipments) {
    if (await findEffect(tx, uploadKey(other.id))) reportedBefore = true;
  }
  const liveOthers = event.otherShipments.filter((other) => !other.cancelled).length;
  const unified = event.allDelivered && liveOthers === 0 && !reportedBefore;

  if (!unified && event.deliveryMode !== 'express') {
    if (!event.allDelivered) {
      ctx.logger.info(
        { orderId: event.orderId, shipmentId: event.shipmentId, deliveryMode: event.deliveryMode },
        'wechat shipping: a non-express part of a split delivery is reported with the last part',
      );
      return;
    }
    if (!reportedBefore) {
      // No part went to WeChat, because none was express: the last one
      // reports the whole order, once, as 统一发货.
      await recordEffect(tx, ctx, {
        ...uploadKey(event.shipmentId),
        payload: {
          orderId: event.orderId,
          shipmentId: event.shipmentId,
          deliveryMode: 1,
          isAllDelivered: true,
          wholeOrder: true,
        } satisfies UploadPayload,
      });
      return;
    }
    ctx.logger.warn(
      { orderId: event.orderId, shipmentId: event.shipmentId, deliveryMode: event.deliveryMode },
      'wechat shipping: the last part of a split delivery is not express; WeChat takes nothing more',
    );
    await announceBlocked(tx, ctx, {
      orderId: event.orderId,
      orderNo: event.orderNo,
      shipmentId: event.shipmentId,
      reason:
        '分拆发货已按快递录入过，最后一个包裹不是快递，微信不接受；请在小程序后台「发货信息管理」中手动完成发货录入',
    });
    return;
  }

  await recordEffect(tx, ctx, {
    ...uploadKey(event.shipmentId),
    payload: {
      orderId: event.orderId,
      shipmentId: event.shipmentId,
      deliveryMode: unified ? 1 : 2,
      isAllDelivered: event.allDelivered,
    } satisfies UploadPayload,
  });
}

/**
 * 修改发货信息 after WeChat already has the shipment. An upload still pending
 * will read the new details itself, so only a *done* one needs correcting; the
 * effect key makes it once per shipment, which is WeChat's limit too.
 */
async function recordCorrection(tx: Tx, ctx: Ctx, event: ShipmentUpdatedEvent): Promise<void> {
  const upload = await findEffect(tx, uploadKey(event.shipmentId));
  if (!upload || upload.status !== 'done') return;
  await recordEffect(tx, ctx, {
    scope: 'shipment',
    scopeId: String(event.shipmentId),
    eventType: CORRECT_SHIPPING,
    payload: { orderId: event.orderId, shipmentId: event.shipmentId },
  });
}

async function announceBlocked(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: number; orderNo: string; shipmentId: number; reason: string },
): Promise<void> {
  await notify(tx, ctx, {
    event: SHIPPING_BLOCKED_EVENT,
    subject: { scope: 'shipment', id: input.shipmentId },
    data: { orderId: input.orderId, orderNo: input.orderNo, reason: input.reason },
  });
}

// ---------------------------------------------------------------------------
// after commit: the uploads
// ---------------------------------------------------------------------------

function uploadPayloadOf(effect: Pick<Effect, 'payload'>): UploadPayload {
  const raw = (effect.payload ?? {}) as Partial<UploadPayload>;
  return {
    orderId: Number(raw.orderId),
    shipmentId: Number(raw.shipmentId),
    deliveryMode: raw.deliveryMode === 1 ? 1 : 2,
    isAllDelivered: raw.isAllDelivered === true,
    ...(raw.wholeOrder === true ? { wholeOrder: true } : {}),
  };
}

const LOGISTICS: Record<ShipmentReportFacts['shipment']['deliveryMode'], MiniLogisticsType> = {
  express: 1,
  merchant_delivery: 2,
  virtual: 3,
};

/**
 * What one upload describes: this shipment, or — for a `wholeOrder` upload —
 * every live shipment of the order, reported as the one delivery WeChat sees.
 * A mix of 商家配送 and 虚拟发货 is reported as 同城配送 (2), the one of the two
 * that has something physical in it.
 */
async function uploadScope(
  ctx: Ctx,
  facts: ShipmentReportFacts,
  payload: UploadPayload,
): Promise<{ lines: { name: string; quantity: number }[]; logisticsType: MiniLogisticsType }> {
  const own = facts.shipment.lines.map((line) => ({
    name: line.productName,
    quantity: line.quantity,
  }));
  if (!payload.wholeOrder) {
    return { lines: own, logisticsType: LOGISTICS[facts.shipment.deliveryMode] };
  }
  const lines: { name: string; quantity: number }[] = [];
  const modes = new Set([facts.shipment.deliveryMode]);
  for (const earlier of facts.earlierShipmentIds) {
    const part = await shipmentReportFacts(ctx, earlier);
    if (!part || part.shipment.status === 'cancelled') continue;
    modes.add(part.shipment.deliveryMode);
    for (const line of part.shipment.lines) {
      lines.push({ name: line.productName, quantity: line.quantity });
    }
  }
  lines.push(...own);
  return {
    lines,
    logisticsType: modes.has('merchant_delivery') ? LOGISTICS.merchant_delivery : LOGISTICS.virtual,
  };
}

/** Throws — and so waits in the ledger — for what an operator has to fix first. */
function buildUpload(
  facts: ShipmentReportFacts,
  attempt: repo.AttemptRow,
  payload: UploadPayload,
  at: Date,
  scope: { lines: { name: string; quantity: number }[]; logisticsType: MiniLogisticsType },
): MiniUploadShipping {
  const payerOpenid = attempt.context.openid;
  if (!payerOpenid) {
    throw new ShippingBlocked(
      `支付单 ${attempt.outTradeNo} 没有付款人 openid，无法自动录入；请在小程序后台「发货信息管理」中手动录入`,
    );
  }
  const logisticsType = scope.logisticsType;
  const itemDesc = describeItems(scope.lines);
  const pkg: MiniShippingPackage = { itemDesc };
  if (logisticsType === 1) {
    const company = facts.expressCompany;
    if (!company?.wechatDeliveryId) {
      throw new ShippingBlocked(
        `快递公司「${company?.name ?? '未知'}」未填写微信快递编码，请在「快递公司」中补全，补全后会自动重新录入`,
      );
    }
    if (!facts.shipment.trackingNo) {
      throw new ShippingBlocked('快递发货缺少运单号，请在订单中「修改物流」补全后自动重新录入');
    }
    pkg.trackingNo = facts.shipment.trackingNo;
    pkg.expressCompany = company.wechatDeliveryId;
    if (isShunfeng(company)) pkg.receiverContact = maskPhone(facts.order.receiverPhone);
  }
  return {
    key:
      attempt.transactionId !== null
        ? { kind: 'transaction', transactionId: attempt.transactionId }
        : { kind: 'merchant', mchId: attempt.mchId, outTradeNo: attempt.outTradeNo },
    logisticsType,
    deliveryMode: payload.deliveryMode,
    isAllDelivered: payload.isAllDelivered,
    packages: [pkg],
    uploadTime: at,
    payerOpenid,
  };
}

/**
 * WeChat's answers that mean "it already has this": the replay of an upload it
 * took (`10060002` 已完成发货) and a correction identical to what it has
 * (`10060023` 发货信息未更新).
 */
const ALREADY_REPORTED = new Set([10060002, 10060023]);
/**
 * Answers that end the effect with nothing to retry: the one correction is
 * spent (`10060003`), or the payment can no longer be shipped (`10060004`:
 * refunded in full, closed).
 */
const NOTHING_TO_REPORT = new Set([10060003, 10060004]);

/**
 * `buildUpload`, telling the operators the first time it is blocked on them.
 * The notice is keyed by the shipment, so a retry does not repeat it; the
 * throw keeps the effect waiting for the fix.
 */
async function buildOrAnnounce(
  ctx: Ctx,
  facts: ShipmentReportFacts,
  attempt: repo.AttemptRow,
  payload: UploadPayload,
): Promise<MiniUploadShipping> {
  const scope = await uploadScope(ctx, facts, payload);
  try {
    return buildUpload(facts, attempt, payload, ctx.clock.now(), scope);
  } catch (error) {
    if (error instanceof ShippingBlocked) {
      await ctx.withTx((tx) =>
        announceBlocked(tx, ctx, {
          orderId: facts.order.id,
          orderNo: facts.order.orderNo,
          shipmentId: payload.shipmentId,
          reason: error.message,
        }),
      );
    }
    throw error;
  }
}

async function uploadShipping(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = uploadPayloadOf(effect);
  const facts = await shipmentReportFacts(ctx, payload.shipmentId);
  if (!facts) {
    ctx.logger.warn({ shipmentId: payload.shipmentId }, 'wechat shipping: shipment vanished');
    return;
  }
  if (facts.shipment.status === 'cancelled') {
    ctx.logger.info(
      { shipmentId: payload.shipmentId },
      'wechat shipping: cancelled before it was reported; nothing sent',
    );
    return;
  }
  const attempt = await repo.findPaidAttempt(ctx.db, facts.order.id);
  if (!attempt || attempt.channel !== 'wechat_mini' || attempt.transactionId === null) return;

  for (const earlier of facts.earlierShipmentIds) {
    const prior = await findEffect(ctx.db, uploadKey(earlier));
    if (prior && prior.status !== 'done') {
      const waiting = `等待发货单 ${earlier} 先录入微信（分拆发货按发货顺序录入）`;
      throw new SummarizedError(waiting, waiting);
    }
  }

  const request = await buildOrAnnounce(ctx, facts, attempt, payload);
  await tradeRepo.ensureTradeOrder(ctx.db, {
    orderId: facts.order.id,
    paymentAttemptId: attempt.id,
    mchId: attempt.mchId,
    outTradeNo: attempt.outTradeNo,
    transactionId: attempt.transactionId,
  });

  const answer = await miniShippingPort(ctx).uploadShippingInfo(request);
  if (answer.ok || ALREADY_REPORTED.has(answer.errcode)) {
    await tradeRepo.markUploaded(ctx.db, {
      orderId: facts.order.id,
      at: ctx.clock.now(),
      allDelivered: payload.isAllDelivered,
    });
    ctx.logger.info(
      { orderId: facts.order.id, shipmentId: payload.shipmentId, errcode: answer.errcode },
      'wechat shipping reported',
    );
    return;
  }
  if (NOTHING_TO_REPORT.has(answer.errcode)) {
    ctx.logger.warn(
      { orderId: facts.order.id, errcode: answer.errcode, errmsg: answer.errmsg },
      'wechat shipping: WeChat will not take this upload; not retried',
    );
    return;
  }
  throw new SummarizedError(
    `微信发货信息录入失败: ${answer.errcode} ${answer.errmsg}`.slice(0, 300),
    `微信没有接受发货信息（错误码 ${answer.errcode}），${UNEXPLAINED}`,
  );
}

async function correctShipping(ctx: Ctx, effect: Effect): Promise<void> {
  const shipmentId = Number((effect.payload as { shipmentId?: number } | null)?.shipmentId);
  const upload = await findEffect(ctx.db, uploadKey(shipmentId));
  if (!upload) return;
  const facts = await shipmentReportFacts(ctx, shipmentId);
  if (!facts || facts.shipment.status === 'cancelled') return;
  const attempt = await repo.findPaidAttempt(ctx.db, facts.order.id);
  if (!attempt || attempt.channel !== 'wechat_mini' || attempt.transactionId === null) return;
  const trade = await tradeRepo.findTradeOrderByOrder(ctx.db, facts.order.id);
  if (trade?.correctedAt) {
    ctx.logger.warn(
      { orderId: facts.order.id, shipmentId },
      'wechat shipping: the one correction WeChat allows is already spent; not sent',
    );
    return;
  }

  const request = await buildOrAnnounce(ctx, facts, attempt, uploadPayloadOf(upload));
  const answer = await miniShippingPort(ctx).uploadShippingInfo(request);
  if (answer.ok || ALREADY_REPORTED.has(answer.errcode) || NOTHING_TO_REPORT.has(answer.errcode)) {
    await tradeRepo.claimCorrection(ctx.db, { orderId: facts.order.id, at: ctx.clock.now() });
    return;
  }
  throw new SummarizedError(
    `微信发货信息修改失败: ${answer.errcode} ${answer.errmsg}`.slice(0, 300),
    `微信没有接受修改后的发货信息（错误码 ${answer.errcode}），${UNEXPLAINED}`,
  );
}

// ---------------------------------------------------------------------------
// after commit: WeChat's pushes
// ---------------------------------------------------------------------------

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** WeChat's times are epoch seconds; 0 or absent means "not yet". */
function epoch(value: unknown): Date | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * `trade_manage_order_settlement`: the buyer confirmed receipt (by hand, or
 * WeChat's own timeout), and/or the money settled. The confirmation moves a
 * `shipped` order to `received` through the same conditional transition the
 * buyer's button and the auto-receive job use, so whichever arrives second is
 * a no-op.
 */
async function onSettlement(ctx: Ctx, effect: Effect): Promise<void> {
  const message = (effect.payload ?? {}) as Record<string, unknown>;
  const trade = await tradeRepo.findTradeOrderByPayment(ctx.db, {
    outTradeNo: text(message['merchant_trade_no']),
    transactionId: text(message['transaction_id']),
  });
  if (!trade) {
    ctx.logger.warn(
      { outTradeNo: text(message['merchant_trade_no']) },
      'wechat settlement push for a payment we never reported; ignored',
    );
    return;
  }
  const now = ctx.clock.now();
  const confirmedAt = epoch(message['confirm_receive_time']);
  if (confirmedAt) {
    const auto = Number(message['confirm_receive_method']) === 2;
    await tradeRepo.markConfirmed(ctx.db, {
      orderId: trade.orderId,
      at: confirmedAt,
      source: auto ? 'auto' : 'manual',
      now,
    });
    await receiveOrder(ctx, {
      orderId: trade.orderId,
      by: 'wechat',
      message: auto ? '微信超时自动确认收货' : '用户在微信确认收货',
    });
  }
  const settledAt = epoch(message['settlement_time']);
  if (settledAt)
    await tradeRepo.markSettled(ctx.db, { orderId: trade.orderId, at: settledAt, now });
}

async function onRemindShipping(ctx: Ctx, effect: Effect): Promise<void> {
  const message = (effect.payload ?? {}) as Record<string, unknown>;
  const outTradeNo = text(message['merchant_trade_no']);
  const attempt = outTradeNo === '' ? null : await repo.findAttemptByOutTradeNo(ctx.db, outTradeNo);
  if (!attempt) {
    ctx.logger.warn({ outTradeNo }, 'wechat shipping reminder for an unknown payment; ignored');
    return;
  }
  const facts = await ctx.withTx(async (tx) => {
    const orderNo = (await repo.findOrderForPayment(tx, attempt.orderId))?.orderNo ?? null;
    await notify(tx, ctx, {
      event: SHIPPING_OVERDUE_EVENT,
      subject: { scope: 'order', id: attempt.orderId },
      data: { orderId: attempt.orderId, orderNo: orderNo ?? outTradeNo, outTradeNo },
    });
    return orderNo;
  });
  ctx.logger.warn(
    { orderId: attempt.orderId, orderNo: facts },
    'wechat: order overdue for shipping',
  );
}

async function onManaged(ctx: Ctx): Promise<void> {
  ctx.logger.warn({}, 'wechat: the mini program is now under 发货信息管理');
  await ctx.config.set(miniTradeConfig, {
    managed: 'yes',
    managedCheckedAt: ctx.clock.now().toISOString(),
  });
  await ctx.withTx((tx) =>
    notify(tx, ctx, {
      event: MINI_TRADE_MANAGED_EVENT,
      subject: { scope: 'wechat-mini', id: 'trade-managed' },
      data: {},
    }),
  );
}

// ---------------------------------------------------------------------------
// the storefront: WeChat's 确认收货 component
// ---------------------------------------------------------------------------

/** `GET /api/v1/orders/:id/wechat-receipt`. */
export async function wechatReceipt(
  ctx: Ctx,
  params: { id: string },
): Promise<WechatReceiptResult> {
  const order = await requireOwnOrder(ctx, params.id);
  if (order.status !== 'shipped') return { receipt: null };
  const trade = await tradeRepo.findTradeOrderByOrder(ctx.db, order.id);
  if (!trade || trade.allDeliveredAt === null) return { receipt: null };
  return { receipt: { transactionId: trade.transactionId } };
}

/**
 * `order_state` 3 确认收货, 4 交易完成 and 6 资金待结算 all come after the
 * buyer confirmed; 1, 2 and 5 do not.
 */
const CONFIRMED_STATES = new Set([3, 4, 6]);

async function verifyReceipt(
  ctx: Ctx,
  input: { orderId: number },
): Promise<'confirmed' | 'not-confirmed' | 'unavailable'> {
  const trade = await tradeRepo.findTradeOrderByOrder(ctx.db, input.orderId);
  if (!trade || trade.uploadedAt === null) return 'unavailable';
  let orderState: number | null;
  try {
    const answer = await miniShippingPort(ctx).getOrder({
      kind: 'transaction',
      transactionId: trade.transactionId,
    });
    if (!answer.ok) return 'unavailable';
    orderState = answer.orderState;
  } catch (error) {
    ctx.logger.warn({ err: error, orderId: input.orderId }, 'wechat get_order failed');
    return 'unavailable';
  }
  if (orderState === null || !CONFIRMED_STATES.has(orderState)) return 'not-confirmed';
  const now = ctx.clock.now();
  await tradeRepo.markConfirmed(ctx.db, {
    orderId: input.orderId,
    at: now,
    source: 'component',
    now,
  });
  return 'confirmed';
}

// ---------------------------------------------------------------------------
// the admin: status and 同步
// ---------------------------------------------------------------------------

const instantOrNull = (value: string): string | null => (value === '' ? null : value);

export async function miniTradeStatus(ctx: Ctx): Promise<MiniTradeStatus> {
  requirePermission(ctx, paymentPermissions['config:write']);
  const config = await ctx.config.get(miniTradeConfig);
  return {
    uploadEnabled: config.uploadEnabled,
    managed: config.managed === 'unknown' ? null : config.managed === 'yes',
    managedCheckedAt: instantOrNull(config.managedCheckedAt),
    msgJumpPath: config.msgJumpPath === '' ? null : config.msgJumpPath,
    msgJumpPathSetAt: instantOrNull(config.msgJumpPathSetAt),
    expectedMsgJumpPath: MSG_JUMP_PATH,
  };
}

/** WeChat said no to a step of 同步: the toast says what the code means, the errmsg goes to the log. */
function syncRefused(
  ctx: Ctx,
  step: string,
  answer: { errcode: number; errmsg: string },
): DomainError {
  ctx.logger.warn(
    { step, errcode: answer.errcode, errmsg: answer.errmsg },
    'mini trade sync refused',
  );
  return new DomainError('PAYMENT_MINI_TRADE_SYNC_FAILED', {
    message: wechatRefusal('同步微信发货信息管理失败', answer.errcode),
    details: { step, errcode: answer.errcode },
  });
}

/**
 * 同步: `is_trade_managed`, then `set_msg_jump_path`.
 *
 * Run by an operator, not on a config save and not at every deploy: it needs
 * the mini program's credentials to be in place, WeChat's answer is something
 * the operator has to see (未纳入 means the uploads are not needed yet; a
 * refusal needs a human), and the path only changes with a release that moves
 * the order page — which is exactly when somebody is looking.
 */
export async function syncMiniTrade(ctx: Ctx): Promise<MiniTradeStatus> {
  requirePermission(ctx, paymentPermissions['config:write']);
  const credentials = await ctx.config.get(wechatConfig);
  if (credentials.miniAppId.trim() === '' || credentials.miniAppSecret.trim() === '') {
    throw new DomainError('PAYMENT_MINI_NOT_CONFIGURED');
  }
  const port = miniShippingPort(ctx);
  const at = ctx.clock.now().toISOString();

  const managed = await port.isTradeManaged();
  if (!managed.ok) throw syncRefused(ctx, 'is_trade_managed', managed);
  await ctx.config.set(miniTradeConfig, {
    managed: managed.managed === true ? 'yes' : managed.managed === false ? 'no' : 'unknown',
    managedCheckedAt: at,
  });

  const jump = await port.setMsgJumpPath(MSG_JUMP_PATH);
  if (!jump.ok) throw syncRefused(ctx, 'set_msg_jump_path', jump);
  await ctx.config.set(miniTradeConfig, { msgJumpPath: MSG_JUMP_PATH, msgJumpPathSetAt: at });
  return miniTradeStatus(ctx);
}
