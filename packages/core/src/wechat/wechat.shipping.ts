import type { Ctx } from '../kernel/context';
import { getWechatClient } from './wechat.client';
import { wechatConfig } from './wechat.config';

/**
 * 小程序发货信息管理 — the port, its real driver over `api.weixin.qq.com`, and
 * the pure mapping from "a parcel left" to WeChat's `upload_shipping_info` body.
 *
 * A mini program WeChat has put under 发货信息管理 has every payment **frozen**
 * until it is told the goods left and the buyer confirmed receipt (C07). The
 * four endpoints below are all of it:
 *
 * | Endpoint                               | Who calls it                                  |
 * | -------------------------------------- | --------------------------------------------- |
 * | `/wxa/sec/order/upload_shipping_info`  | the `wechat.uploadShipping` effect (payment)  |
 * | `/wxa/sec/order/get_order`             | 确认收货 via WeChat's component, before we believe it |
 * | `/wxa/sec/order/set_msg_jump_path`     | the admin's 同步 button                        |
 * | `/wxa/sec/order/is_trade_managed`      | the admin's 同步 button                        |
 *
 * Like every call in `wechat.client.ts`, a WeChat `errcode` is a return value
 * and a transport failure throws: the caller is an effect, and a throw is a
 * retry. The fake is `startFakeOaServer()` in `@shop/testing`, which speaks the
 * same four endpoints; `registerMiniShippingPort` exists for a unit test that
 * wants no HTTP at all.
 */

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

/**
 * Which payment WeChat should file the shipping under. `transaction` (微信支付单号,
 * `order_number_type = 2`) is preferred; `merchant` (`mchid` + `out_trade_no`,
 * type 1) is the fallback C07 names for a payment whose transaction id we lack.
 */
export type MiniTradeKey =
  | { kind: 'transaction'; transactionId: string }
  | { kind: 'merchant'; mchId: string; outTradeNo: string };

/** WeChat's `logistics_type`: 1 实体物流, 2 同城配送, 3 虚拟商品, 4 用户自提. */
export type MiniLogisticsType = 1 | 2 | 3 | 4;

export interface MiniShippingPackage {
  /** 运单号; `logistics_type = 1` only. */
  trackingNo?: string;
  /** WeChat's `delivery_id` for the carrier; `logistics_type = 1` only. */
  expressCompany?: string;
  /** 商品信息, at most 120 characters (`describeItems`). */
  itemDesc: string;
  /** 收件人联系方式, masked (`maskPhone`) — required by WeChat for 顺丰 only. */
  receiverContact?: string;
}

export interface MiniUploadShipping {
  key: MiniTradeKey;
  logisticsType: MiniLogisticsType;
  /** 1 统一发货 (one go), 2 分拆发货 (in parts; `isAllDelivered` on the last part). */
  deliveryMode: 1 | 2;
  isAllDelivered: boolean;
  packages: MiniShippingPackage[];
  uploadTime: Date;
  /** The paying user's mini-program openid. */
  payerOpenid: string;
}

export interface MiniShippingAnswer {
  ok: boolean;
  errcode: number;
  errmsg: string;
}

/**
 * `order_state`: 1 待发货, 2 已发货, 3 确认收货, 4 交易完成, 5 已退款,
 * 6 资金待结算 (C07).
 */
export interface MiniTradeOrderAnswer extends MiniShippingAnswer {
  orderState: number | null;
}

export interface MiniTradeManagedAnswer extends MiniShippingAnswer {
  managed: boolean | null;
}

export interface MiniShippingPort {
  uploadShippingInfo(input: MiniUploadShipping): Promise<MiniShippingAnswer>;
  getOrder(key: MiniTradeKey): Promise<MiniTradeOrderAnswer>;
  setMsgJumpPath(path: string): Promise<MiniShippingAnswer>;
  isTradeManaged(): Promise<MiniTradeManagedAnswer>;
}

let override: ((ctx: Ctx) => MiniShippingPort) | undefined;

/** Replaces the driver — for a unit test only; the integration tests use the fake server. */
export function registerMiniShippingPort(factory: (ctx: Ctx) => MiniShippingPort): void {
  override = factory;
}

/** Test helper. Never call this from app code. */
export function resetMiniShippingPort(): void {
  override = undefined;
}

export function miniShippingPort(ctx: Ctx): MiniShippingPort {
  return override ? override(ctx) : wechatMiniShippingDriver(ctx);
}

// ---------------------------------------------------------------------------
// WeChat's error codes the callers act on
// ---------------------------------------------------------------------------

/**
 * The `upload_shipping_info` refusals that mean "there is nothing (more) to
 * report", which the effect finishes on rather than retries:
 *
 * - `10060002` 支付单已完成发货: the at-least-once replay of an upload WeChat
 *   already took (the effect crashed between the call and marking itself done).
 * - `10060003` 已使用重新发货机会: the one correction is spent.
 * - `10060004` 支付单处于不可发货的状态: refunded in full, or closed.
 * - `10060023` 发货信息未更新: a correction identical to what WeChat has.
 */
export const SHIPPING_SETTLED_ERRCODES: ReadonlySet<number> = new Set([
  10060002, 10060003, 10060004, 10060023,
]);

// ---------------------------------------------------------------------------
// pure mapping
// ---------------------------------------------------------------------------

/** WeChat's cap on `item_desc` (C07). */
export const ITEM_DESC_MAX = 120;

/**
 * `商品A×2；商品B×1`, cut to 120 characters (by code point, so a split
 * surrogate pair cannot make the body invalid UTF-8).
 */
export function describeItems(lines: readonly { name: string; quantity: number }[]): string {
  const text = lines.map((line) => `${line.name.trim()}×${line.quantity}`).join('；');
  const chars = [...(text === '' ? '商品' : text)];
  if (chars.length <= ITEM_DESC_MAX) return chars.join('');
  return `${chars.slice(0, ITEM_DESC_MAX - 1).join('')}…`;
}

/**
 * A phone number with everything but the last four digits masked, which is
 * the only form WeChat accepts in `receiver_contact`: `138****8000`.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\s+/g, '');
  if (digits.length <= 4) return `****${digits}`;
  const tail = digits.slice(-4);
  const head = digits.length >= 11 ? digits.slice(0, 3) : '';
  return `${head}****${tail}`;
}

/** RFC 3339 in Beijing time with milliseconds: `2026-06-01T08:00:00.000+08:00`. */
export function rfc3339Shanghai(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 3_600_000);
  return `${shifted.toISOString().slice(0, 23)}+08:00`;
}

/** Is this carrier 顺丰, which WeChat requires `receiver_contact` for? */
export function isShunfeng(company: { name: string; wechatDeliveryId: string | null }): boolean {
  return company.wechatDeliveryId === 'SF' || company.name.includes('顺丰');
}

export function orderKeyBody(key: MiniTradeKey): Record<string, unknown> {
  return key.kind === 'transaction'
    ? { order_number_type: 2, transaction_id: key.transactionId }
    : { order_number_type: 1, mchid: key.mchId, out_trade_no: key.outTradeNo };
}

/** The `upload_shipping_info` body, exactly. */
export function uploadShippingBody(input: MiniUploadShipping): Record<string, unknown> {
  return {
    order_key: orderKeyBody(input.key),
    logistics_type: input.logisticsType,
    delivery_mode: input.deliveryMode,
    // Only a split delivery carries it; on a unified one WeChat reads its
    // presence as a request for split semantics.
    ...(input.deliveryMode === 2 ? { is_all_delivered: input.isAllDelivered } : {}),
    shipping_list: input.packages.map((pkg) => ({
      ...(pkg.trackingNo === undefined ? {} : { tracking_no: pkg.trackingNo }),
      ...(pkg.expressCompany === undefined ? {} : { express_company: pkg.expressCompany }),
      item_desc: pkg.itemDesc,
      ...(pkg.receiverContact === undefined
        ? {}
        : { contact: { receiver_contact: pkg.receiverContact } }),
    })),
    upload_time: rfc3339Shanghai(input.uploadTime),
    payer: { openid: input.payerOpenid },
  };
}

// ---------------------------------------------------------------------------
// the real driver
// ---------------------------------------------------------------------------

interface Envelope {
  errcode?: number;
  errmsg?: string;
}

function answerOf(value: unknown): MiniShippingAnswer {
  const envelope = (value ?? {}) as Envelope;
  const errcode = envelope.errcode ?? 0;
  return { ok: errcode === 0, errcode, errmsg: envelope.errmsg ?? 'ok' };
}

export function wechatMiniShippingDriver(ctx: Ctx): MiniShippingPort {
  const client = getWechatClient(ctx);
  const post = (path: string, body: unknown) =>
    client.call<unknown>('mini', { method: 'POST', path, body });

  return {
    async uploadShippingInfo(input) {
      const answer = answerOf(
        await post('/wxa/sec/order/upload_shipping_info', uploadShippingBody(input)),
      );
      if (!answer.ok) {
        ctx.logger.warn(
          { errcode: answer.errcode, errmsg: answer.errmsg },
          'wechat upload_shipping_info refused',
        );
      }
      return answer;
    },

    async getOrder(key) {
      const raw = await post(
        '/wxa/sec/order/get_order',
        key.kind === 'transaction'
          ? { transaction_id: key.transactionId }
          : { merchant_id: key.mchId, merchant_trade_no: key.outTradeNo },
      );
      const answer = answerOf(raw);
      const order = (raw as { order?: { order_state?: number } } | null)?.order;
      return { ...answer, orderState: answer.ok ? (order?.order_state ?? null) : null };
    },

    async setMsgJumpPath(path) {
      return answerOf(await post('/wxa/sec/order/set_msg_jump_path', { path }));
    },

    async isTradeManaged() {
      const { miniAppId } = await ctx.config.get(wechatConfig);
      const raw = await post('/wxa/sec/order/is_trade_managed', { appid: miniAppId });
      const answer = answerOf(raw);
      const managed = (raw as { is_trade_managed?: boolean } | null)?.is_trade_managed;
      return { ...answer, managed: answer.ok ? (managed ?? null) : null };
    },
  };
}
