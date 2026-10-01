import { isApiError, type ResponseOf } from '@shop/api-client';
import { linePaidUnitPrice } from '@/lib/order-price';
import { fromCents, toCents } from '@/lib/money';
import type { CheckoutDraft } from './draft';

export type CheckoutPreview = ResponseOf<'order.checkoutPreview'>;
export type CustomFormField = NonNullable<CheckoutPreview['customFormFields']>[number];
export type ApplicableCoupons = ResponseOf<'coupon.applicableList'>;
export type ApplicableCoupon = ApplicableCoupons['items'][number];

/**
 * The shopper's coupon choice: `auto` (the default: the best usable one, as the server ranks
 * them), `none` (不使用优惠券), or one they picked.
 */
export type CouponChoice = { mode: 'auto' } | { mode: 'none' } | { mode: 'picked'; id: string };

/** The coupon to price with, once the applicable list is known; `null` for none. */
export function resolveCoupon(
  choice: CouponChoice,
  applicable: ApplicableCoupons | undefined,
): string | null {
  if (choice.mode === 'none') return null;
  if (choice.mode === 'picked') return choice.id;
  return applicable?.items.find((row) => row.usable)?.coupon.id ?? null;
}

/**
 * `coupon.applicableList`'s lines: each priced line after the activity discounts, before any
 * coupon — the amounts the server measures a 使用门槛 against at checkout too (PRICE-005).
 */
export function couponLinesOf(
  preview: CheckoutPreview,
): { productId: string; amount: string }[] | null {
  const lines = preview.lines.map((line) => ({
    productId: line.productId,
    amount: line.totalAmount,
  }));
  return lines.length > 0 ? lines : null;
}

const COUPON_REASONS: Record<string, string> = {
  COUPON_MIN_SPEND_NOT_MET: '未达到使用门槛',
  COUPON_NOT_APPLICABLE: '所选商品不可用',
  COUPON_NOT_USABLE: '暂不可用',
};

/** An unusable coupon's reason, in words (the server sends the `COUPON_*` code). */
export function couponReason(code: string | null): string {
  if (!code) return '';
  return COUPON_REASONS[code] ?? '暂不可用';
}

/** Answers keyed by field: text for most, a list for 多选. */
export type CustomAnswers = Readonly<Record<string, string | readonly string[]>>;

/** Fields the shopper can fill in here; an 图片 field has no upload purpose yet. */
export function fillable(field: CustomFormField): boolean {
  return field.type !== 'image';
}

/** The first required field left empty (or badly typed), with what to tell the shopper. */
export function customFormProblem(
  fields: readonly CustomFormField[],
  answers: CustomAnswers,
): string | null {
  for (const field of fields) {
    if (!fillable(field)) continue;
    const answer = answers[field.key];
    const empty =
      answer === undefined ||
      (typeof answer === 'string' ? answer.trim() === '' : answer.length === 0);
    if (empty) {
      if (field.required) return `请填写「${field.label}」`;
      continue;
    }
    if (
      field.type === 'number' &&
      typeof answer === 'string' &&
      !/^-?\d+(\.\d+)?$/.test(answer.trim())
    ) {
      return `「${field.label}」请填写数字`;
    }
    if (
      field.type === 'date' &&
      typeof answer === 'string' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(answer.trim())
    ) {
      return `「${field.label}」请按 2026-01-31 的格式填写`;
    }
  }
  return null;
}

/** `order.create`'s `customForm`: trimmed answers, empty ones left out; `undefined` when none. */
export function customFormBody(
  fields: readonly CustomFormField[],
  answers: CustomAnswers,
): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const answer = answers[field.key];
    if (answer === undefined) continue;
    if (typeof answer === 'string') {
      if (answer.trim() === '') continue;
      body[field.key] = field.type === 'number' ? Number(answer.trim()) : answer.trim();
    } else if (answer.length > 0) {
      body[field.key] = [...answer];
    }
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

/** The receiver as `AddressCard` shows it. */
export function receiverCard(receiver: NonNullable<CheckoutPreview['receiver']>) {
  return {
    receiverName: receiver.name,
    receiverPhone: receiver.phone,
    provinceName: receiver.province,
    cityName: receiver.city,
    districtName: receiver.district,
    detail: receiver.detail,
  };
}

const ACTIVITY_PRICE = /:activity-price$/;
const COUPON = /^coupon:/;

/** What 确认订单 prints for a preview (the same split `lib/order-price.ts` makes for an order). */
export interface CheckoutPrices {
  /** 商品金额: after the 拼团 / 预售 price, which is the price, not a discount. */
  itemsAmount: string;
  /** 优惠券: the coupon alone (`couponDiscount` also holds the activity and other rules). */
  couponDiscount: string;
  /** The other rules' rows (满减…), without the coupon and the activity price. */
  otherAdjustments: CheckoutPreview['adjustments'];
  /** Each line's unit price as the shopper pays it, by `itemKey`. */
  unitPrices: Record<string, string>;
}

/**
 * The preview's amounts as the shopper should read them. A 拼团 or 预售 line keeps its catalogue
 * `unitPrice` and the activity comes as an adjustment folded into `couponDiscount`; printed
 * straight, a ¥78 拼团 read ¥88 with a ¥10 优惠券 nobody applied, beside a ¥10 拼团 row.
 */
export function checkoutPrices(preview: CheckoutPreview): CheckoutPrices {
  let activity = 0;
  let coupon = 0;
  for (const adjustment of preview.adjustments) {
    if (ACTIVITY_PRICE.test(adjustment.source)) activity -= toCents(adjustment.amount);
    else if (COUPON.test(adjustment.source)) coupon -= toCents(adjustment.amount);
  }
  const otherAdjustments = preview.adjustments.filter(
    (adjustment) => !ACTIVITY_PRICE.test(adjustment.source) && !COUPON.test(adjustment.source),
  );
  const unitPrices: Record<string, string> = {};
  // An activity order is one line (立即购买), so the whole activity discount is that line's.
  const single = preview.lines.length === 1;
  for (const line of preview.lines) {
    unitPrices[line.itemKey] =
      single && activity > 0
        ? linePaidUnitPrice({ ...line, adjustments: [] }, activity)
        : line.unitPrice;
  }
  return {
    itemsAmount: fromCents(Math.max(0, toCents(preview.itemsAmount) - Math.max(0, activity))),
    couponDiscount: fromCents(Math.max(0, coupon)),
    otherAdjustments,
    unitPrices,
  };
}

/** 运费 on 确认订单: nothing to say about 包邮 until there is an address to price it for. */
export function freightText(preview: CheckoutPreview): string {
  if (preview.addressRequired && !preview.receiver) return '请选择收货地址';
  return toCents(preview.freightAmount) === 0 ? '包邮' : `¥${preview.freightAmount}`;
}

/** A preview the server refused for one of the lines: what to tell the shopper, by name. */
export interface CheckoutRefusal {
  title: string;
  description: string;
}

const COUPON_CODES = /^COUPON_/;

function detailsOf(error: { details?: unknown }): Record<string, unknown> {
  return typeof error.details === 'object' && error.details !== null
    ? (error.details as Record<string, unknown>)
    : {};
}

/**
 * The server said no to the lines themselves (下架, 限购, 起购, 卡密 quantity, an ended activity):
 * reloading will not help, so 确认订单 says which item and why, and offers the way back. `null`
 * for anything else (a network or server failure: 重新加载; the address and coupon cases the
 * page handles itself).
 */
export function checkoutRefusal(error: unknown, draft: CheckoutDraft): CheckoutRefusal | null {
  if (!isApiError(error) || (error.status !== 409 && error.status !== 422)) return null;
  if (COUPON_CODES.test(error.code) || error.code === 'ORDER_ADDRESS_NOT_FOUND') return null;
  if (error.code === 'SHIPPING_NOT_DELIVERABLE') return null;
  const details = detailsOf(error);
  const skuId =
    typeof details['skuId'] === 'string'
      ? details['skuId']
      : Array.isArray(details['skuIds']) && typeof details['skuIds'][0] === 'string'
        ? details['skuIds'][0]
        : undefined;
  const name = skuId ? draft.names?.[skuId] : undefined;
  const item = name ? `「${name}」` : '该商品';
  const back = draft.source === 'cart' ? '请返回购物车调整后再结算' : '请返回调整后再购买';
  const limit = typeof details['limit'] === 'number' ? details['limit'] : null;
  const purchased = typeof details['purchased'] === 'number' ? details['purchased'] : null;
  const minimum = typeof details['minimum'] === 'number' ? details['minimum'] : null;
  switch (error.code) {
    case 'ORDER_ITEM_UNAVAILABLE':
      return { title: `${item}已下架或暂不可购买`, description: back };
    case 'ORDER_PURCHASE_LIMIT_REACHED':
      if (limit !== null && purchased !== null) {
        return {
          title: `${item}每人限购 ${limit} 件`,
          description:
            purchased >= limit
              ? `你已购买过 ${purchased} 件，不能再购买了`
              : `你已购买过 ${purchased} 件，最多还能买 ${limit - purchased} 件`,
        };
      }
      return {
        title: limit !== null ? `${item}每单限购 ${limit} 件` : `${item}超出限购数量`,
        description: back,
      };
    case 'ORDER_BELOW_MIN_PURCHASE':
      return {
        title: minimum !== null ? `${item}最少购买 ${minimum} 件` : `${item}未达到起购数量`,
        description: back,
      };
    case 'ORDER_VIRTUAL_CARD_QUANTITY':
      return { title: `${item}每单只能购买 1 件`, description: back };
    default:
      return { title: error.message, description: back };
  }
}
