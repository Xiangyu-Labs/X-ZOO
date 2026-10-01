import type {
  CheckoutCreateBody,
  CheckoutKind,
  CheckoutLine,
  CheckoutPreview,
  CheckoutPreviewBody,
  OrderDetail,
  OrderReceiver,
} from '@shop/contracts/order/schemas';
import type { DbOrTx } from '@shop/db';
import * as coupon from '../coupon';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, generateOrderNo, toId, toIdOrNull } from '../kernel/ids';
import { Money } from '../kernel/money';
import { notify } from '../notification';
import {
  resolveCatalogPort,
  resolveFreightPort,
  resolvePaymentPort,
  resolveStockPort,
  type CustomFormField,
  type SkuForSale,
} from './catalog.port';
import { orderConfig } from './order.config';
import {
  couponAdjustment,
  freightLineOf,
  goodsTotalOf,
  lineSubtotal,
  payableOf,
  pricingLineOf,
  splitAdjustments,
  type DiscountSplit,
} from './order.pricing';
import { detailOf } from './order.query.service';
import * as repo from './order.repo';
import type { OrderItemSnapshot } from './order.repo';
import {
  getOrderKindHandler,
  getPricingContributors,
  type PriceAdjustment,
  type StockLine,
} from './ports';

/**
 * 确认订单 and 提交订单.
 *
 * The design in one sentence: **preview and create take the same input and
 * price it the same way, from scratch, on the server**. A cached draft handed
 * from confirm to submit is a chance for the draft and the world to disagree,
 * and the source of the "price changed between confirm and submit" class of
 * bug. Here there is one `buildDraft`, called by both, and the only thing the
 * client may assert is `expectedPayableAmount`, which is checked and refused
 * rather than trusted.
 *
 * The creating transaction, in order:
 *
 *  1. build the draft from the database inside the transaction;
 *  2. insert the order and its items, carrying the client's idempotency key;
 *  3. reserve stock, one conditional statement per line;
 *  4. redeem the coupon, in this same transaction;
 *  5. empty the cart rows the order consumed.
 *
 * Anything that fails aborts all five. A duplicate submit is stopped by
 * `orders_idempotency_uq` in step 2 and answered with the first order. The auto-cancel job is enqueued *after*
 * the commit, because a queue is not transactional.
 */

const AUTO_CANCEL_JOB = 'order.autoCancel';
const UNPAID_REMINDER_JOB = 'order.remindUnpaid';

/** The dedupe key that stops a retried submit queueing two cancellations. */
export function autoCancelKey(orderId: number): string {
  return `order-auto-cancel:${orderId}`;
}

/** The dedupe key of an order's 未付款提醒, so a cancel can withdraw it. */
export function unpaidReminderKey(orderId: number): string {
  return `order-unpaid-reminder:${orderId}`;
}

/**
 * Minutes after the order is placed at which the buyer is reminded to pay, or
 * `null` for none: the reminder is off (`0`), or it would land at or before
 * the moment the order was placed.
 */
export function unpaidReminderDelayMinutes(
  payWindowMinutes: number,
  unpaidReminderMinutes: number,
): number | null {
  if (unpaidReminderMinutes <= 0 || unpaidReminderMinutes >= payWindowMinutes) return null;
  return payWindowMinutes - unpaidReminderMinutes;
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

interface DraftLine {
  /** `null` for 立即购买, which never touches the cart. */
  cartItemId: number | null;
  sku: SkuForSale;
  quantity: number;
  itemKey: string;
  unitPrice: Money;
  subtotal: Money;
}

interface Draft {
  userId: number;
  lines: DraftLine[];
  address: repo.AddressRow | null;
  addressRequired: boolean;
  itemsAmount: Money;
  discount: DiscountSplit;
  freightAmount: Money;
  payableAmount: Money;
  userCouponId: number | null;
  customFormFields: CustomFormField[];
  payWindowMinutes: number;
  unpaidReminderMinutes: number;
  /** The cart rows this draft consumed, for the delete after the order exists. */
  cartItemIds: number[];
}

/** `order_items.item_key` — stable within an order, and one row per variant. */
const itemKeyOf = (skuId: number): string => `sku-${skuId}`;

/**
 * `X-Client-Platform` spells the two WeChat surfaces with a hyphen
 * (`wechat-mini`) and the `orders_platform` enum spells them with an underscore
 * (`wechat_mini`). One translation, here, rather than a guess at each call
 * site. Fulfilment and payment store the same value.
 */
const PLATFORM: Record<string, 'h5' | 'wechat_oa' | 'wechat_mini'> = {
  h5: 'h5',
  'wechat-oa': 'wechat_oa',
  'wechat-mini': 'wechat_mini',
};

async function requestedLines(
  db: DbOrTx,
  userId: number,
  input: CheckoutPreviewBody,
): Promise<{ cartItemId: number | null; skuId: number; quantity: number }[]> {
  if (input.source === 'buy-now') {
    if (!input.item) throw new DomainError('ORDER_EMPTY');
    return [{ cartItemId: null, skuId: fromId(input.item.skuId), quantity: input.item.quantity }];
  }
  const rows = await repo.selectCartLines(db, {
    userId,
    cartItemIds: input.cartItemIds.map(fromId),
  });
  return rows.map((row) => ({
    cartItemId: row.cartItemId,
    skuId: row.skuId,
    quantity: row.quantity,
  }));
}

/**
 * Everything a line must satisfy before it may be priced at all. Stock is
 * *not* checked here: the preview would only be telling the shopper about a
 * number that can change before they submit, and the create path settles it
 * for real with a conditional `reserve`.
 */
function assertSellable(
  sku: SkuForSale | undefined,
  skuId: number,
  quantity: number,
  purchased: number,
): asserts sku is SkuForSale {
  if (!sku || sku.deleted || !sku.onSale) {
    throw new DomainError('ORDER_ITEM_UNAVAILABLE', { details: { skuIds: [toId(skuId)] } });
  }
  if (sku.productKind === 'virtual_card' && quantity > 1) {
    // `product_virtual_cards_order_item_uq`: one card key binds to one order item.
    throw new DomainError('ORDER_VIRTUAL_CARD_QUANTITY', { details: { skuId: toId(skuId) } });
  }
  if (quantity < sku.minPurchaseQuantity) {
    throw new DomainError('ORDER_BELOW_MIN_PURCHASE', {
      details: { skuId: toId(skuId), minimum: sku.minPurchaseQuantity },
    });
  }
  const limit = sku.purchaseLimitQuantity;
  if (sku.purchaseLimitMode === 'per_order' && limit !== null && quantity > limit) {
    throw new DomainError('ORDER_PURCHASE_LIMIT_REACHED', {
      details: { skuId: toId(skuId), limit },
    });
  }
  if (sku.purchaseLimitMode === 'lifetime' && limit !== null && purchased + quantity > limit) {
    throw new DomainError('ORDER_PURCHASE_LIMIT_REACHED', {
      details: { skuId: toId(skuId), limit, purchased },
    });
  }
}

async function resolveAddress(
  db: DbOrTx,
  userId: number,
  addressId: string | null | undefined,
): Promise<repo.AddressRow | null> {
  if (addressId === null) return null;
  if (addressId === undefined) return repo.findDefaultAddress(db, userId);
  const row = await repo.findAddress(db, { id: fromId(addressId), userId });
  if (!row) throw new DomainError('ORDER_ADDRESS_NOT_FOUND');
  return row;
}

/**
 * The same context, reading through the caller's handle.
 *
 * `Ctx.db` is the pool, and on the `create` path this whole pricing pass runs
 * *inside* an open transaction that is already holding one pooled connection. A
 * contributor — or the coupon quote — handed the plain `ctx` therefore reaches
 * for a **second** connection per checkout, and as soon as as many orders are
 * placed at once as the pool is wide, every caller holds one and wants one: the
 * pool deadlocks rather than queues. The cast belongs here, once, rather than
 * in every marketing domain.
 *
 * It is also the more correct read: contributors see the same snapshot the
 * order they are pricing will be written into.
 */
function readingThrough(ctx: Ctx, db: DbOrTx): Ctx {
  return { ...ctx, db: db as Ctx['db'] };
}

/**
 * Gathers every adjustment: the registered `PricingContributor`s in `priority`
 * order first, then the coupon. The coupon runs last on purpose — it is the
 * thing the shopper picked, so it should apply to what the automatic rules
 * left, not the other way round.
 *
 * That includes its 使用门槛: a coupon's minimum spend is measured against what
 * the lines cost after the 拼团/预售 price, the same `totalAmount` the checkout
 * shows and the mini-program sends to `coupon.applicableList` (PRICE-005). A
 * coupon listed as usable is therefore never refused here, and one listed as
 * 未达到使用门槛 is never quietly applied.
 */
async function gatherAdjustments(
  ctx: Ctx,
  db: DbOrTx,
  userId: number,
  lines: readonly DraftLine[],
  userCouponId: number | null,
  selections: Record<string, string | undefined>,
): Promise<PriceAdjustment[]> {
  const draft = {
    userId,
    lines: lines.map(pricingLineOf),
    goodsTotal: goodsTotalOf(lines),
    selections,
  };
  const reading = readingThrough(ctx, db);

  const out: PriceAdjustment[] = [];
  for (const contributor of getPricingContributors()) {
    out.push(...(await contributor.contribute(reading, draft)));
  }

  if (userCouponId !== null) {
    const activity = splitAdjustments(lines, out).perLine;
    const quoted = await coupon.quote(reading, {
      userCouponId,
      userId,
      lines: lines.map((line, index) => ({
        productId: line.sku.productId,
        categoryIds: line.sku.categoryIds,
        amount: line.subtotal.sub(activity[index] ?? Money.ZERO),
      })),
    });
    out.push(
      couponAdjustment({
        label: '优惠券抵扣',
        discount: quoted.discount,
        lines,
        eligibleLineIndexes: quoted.eligibleLineIndexes,
      }),
    );
  }
  return out;
}

async function quoteFreight(
  ctx: Ctx,
  db: DbOrTx,
  lines: readonly DraftLine[],
  address: repo.AddressRow | null,
  templateOverride: number | null,
): Promise<Money> {
  const physical = lines.filter((line) => line.sku.productKind === 'physical');
  // Nothing to ship, or nowhere to ship it to: the shopper is shown zero and
  // the create path refuses the order for want of an address anyway.
  if (physical.length === 0 || address === null) return Money.ZERO;

  const quote = await resolveFreightPort().quote(db, ctx, {
    addressCityId: address.cityId,
    lines: physical.map((line) => freightLineOf(line, templateOverride)),
  });
  return Money.fromFen(quote.totalFen);
}

function customFormFieldsOf(lines: readonly DraftLine[]): CustomFormField[] {
  const seen = new Map<string, CustomFormField>();
  for (const line of lines) {
    for (const field of line.sku.customForm ?? []) {
      if (!seen.has(field.key)) seen.set(field.key, field);
    }
  }
  return [...seen.values()];
}

/**
 * `kindMeta` as the kind handler and the pricing contributors read it: the
 * declared keys of the kind's own payload, and nothing else.
 *
 * The contract already strips undeclared keys; spelling the keys out here
 * keeps it true for a caller that reaches the service without the contract.
 */
function kindSelections(input: CheckoutKind): Record<string, string | undefined> {
  switch (input.kind) {
    case 'groupbuy':
      return { activityId: input.kindMeta.activityId, groupId: input.kindMeta.groupId };
    case 'presale':
      return { activityId: input.kindMeta.activityId };
    default:
      return {};
  }
}

async function buildDraft(
  ctx: Ctx,
  db: DbOrTx,
  userId: number,
  input: CheckoutPreviewBody,
): Promise<Draft> {
  const requested = await requestedLines(db, userId, input);
  if (requested.length === 0) throw new DomainError('ORDER_EMPTY');

  const catalog = resolveCatalogPort();
  const skus = await catalog.getSkusForSale(
    db,
    requested.map((line) => line.skuId),
  );
  const purchased = await repo.purchasedQuantity(db, {
    userId,
    productIds: [...skus.values()].map((sku) => sku.productId),
  });

  const lines: DraftLine[] = requested.map((line) => {
    const sku = skus.get(line.skuId);
    assertSellable(sku, line.skuId, line.quantity, purchased.get(sku?.productId ?? -1) ?? 0);
    const unitPrice = Money.parse(sku.unitPrice);
    return {
      cartItemId: line.cartItemId,
      sku,
      quantity: line.quantity,
      itemKey: itemKeyOf(line.skuId),
      unitPrice,
      subtotal: lineSubtotal(unitPrice, line.quantity),
    };
  });

  const address = await resolveAddress(db, userId, input.addressId);
  const userCouponId =
    input.userCouponId === null || input.userCouponId === undefined
      ? null
      : fromId(input.userCouponId);

  // A marketing contributor learns which activity the shopper picked from the
  // same `kindMeta` the kind handler gets, plus `kind` so it can refuse to fire
  // on an ordinary order. `kind` goes last: nothing in `kindMeta` may overrule
  // it (ORDER-009).
  const adjustments = await gatherAdjustments(ctx, db, userId, lines, userCouponId, {
    couponId: input.userCouponId ?? undefined,
    ...kindSelections(input),
    kind: input.kind,
  });
  const discount = splitAdjustments(lines, adjustments);
  const itemsAmount = goodsTotalOf(lines);
  const activityTemplate =
    (await getOrderKindHandler(input.kind)?.freightTemplateId?.(db, kindSelections(input))) ?? null;
  const freightAmount = await quoteFreight(ctx, db, lines, address, activityTemplate);
  // Through `db`: on `create` it is the checkout transaction, and a cold cache
  // must not take a second pooled connection while it is open. On the preview
  // it is the pool, where `getIn` is exactly `get`.
  const { payWindowMinutes, unpaidReminderMinutes } = await ctx.config.getIn(db, orderConfig);

  return {
    userId,
    lines,
    address,
    addressRequired: lines.some((line) => line.sku.productKind === 'physical'),
    itemsAmount,
    discount,
    freightAmount,
    payableAmount: payableOf(itemsAmount, freightAmount, discount.total),
    userCouponId,
    customFormFields: customFormFieldsOf(lines),
    payWindowMinutes,
    unpaidReminderMinutes,
    cartItemIds: lines
      .map((line) => line.cartItemId)
      .filter((cartItemId): cartItemId is number => cartItemId !== null),
  };
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

function receiverOf(address: repo.AddressRow | null): OrderReceiver | null {
  if (!address) return null;
  return {
    addressId: toId(address.id),
    name: address.receiverName,
    phone: address.receiverPhone,
    province: address.provinceName,
    city: address.cityName,
    district: address.districtName,
    detail: address.detail,
    postCode: address.postCode,
  };
}

function checkoutLineOf(line: DraftLine, index: number, discount: DiscountSplit): CheckoutLine {
  const share = discount.perLine[index] ?? Money.ZERO;
  return {
    itemKey: line.itemKey,
    productId: toId(line.sku.productId),
    skuId: toId(line.sku.skuId),
    cartItemId: toIdOrNull(line.cartItemId),
    productName: line.sku.productName,
    productImageUrl: line.sku.productImageUrl,
    productKind: line.sku.productKind,
    skuImageUrl: line.sku.skuImageUrl,
    specText: line.sku.specText,
    unitName: line.sku.unitName,
    quantity: line.quantity,
    unitPrice: line.unitPrice.toString(),
    originalUnitPrice: line.sku.originalUnitPrice,
    subtotal: line.subtotal.toString(),
    discountAmount: share.toString(),
    totalAmount: line.subtotal.sub(share).toString(),
  };
}

function toPreview(draft: Draft): Omit<CheckoutPreview, 'shipAfterDays'> {
  return {
    lines: draft.lines.map((line, index) => checkoutLineOf(line, index, draft.discount)),
    receiver: receiverOf(draft.address),
    addressRequired: draft.addressRequired,
    totalQuantity: draft.lines.reduce((sum, line) => sum + line.quantity, 0),
    itemsAmount: draft.itemsAmount.toString(),
    freightAmount: draft.freightAmount.toString(),
    couponDiscount: draft.discount.total.toString(),
    adjustments: draft.discount.applied.map((applied) => ({
      source: applied.source,
      label: applied.label,
      amount: applied.amount.toString(),
    })),
    payableAmount: draft.payableAmount.toString(),
    userCouponId: toIdOrNull(draft.userCouponId),
    payWindowMinutes: draft.payWindowMinutes,
    customFormFields: draft.customFormFields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.options ? { options: field.options } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    })),
  };
}

/** 确认订单. Writes nothing, so the client may call it on every change. */
export async function preview(ctx: Ctx, body: CheckoutPreviewBody): Promise<CheckoutPreview> {
  const userId = requireUserId(ctx);
  const draft = await buildDraft(ctx, ctx.db, userId, body);
  const terms =
    (await getOrderKindHandler(body.kind)?.previewTerms?.(ctx.db, kindSelections(body))) ?? {};
  return { ...toPreview(draft), shipAfterDays: terms.shipAfterDays ?? null };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

function assertCustomFormComplete(
  draft: Draft,
  answers: Record<string, unknown> | undefined,
): void {
  const missing = draft.customFormFields
    .filter((field) => field.required)
    .filter((field) => {
      const value = answers?.[field.key];
      return value === undefined || value === null || value === '';
    })
    .map((field) => field.key);
  if (missing.length > 0) {
    throw new DomainError('ORDER_CUSTOM_FORM_INCOMPLETE', { details: { fields: missing } });
  }
}

function snapshotOf(sku: SkuForSale): OrderItemSnapshot {
  return {
    productName: sku.productName,
    productImageUrl: sku.productImageUrl,
    productKind: sku.productKind,
    skuCode: sku.skuCode,
    specText: sku.specText,
    specValues: sku.specValues,
    ...(sku.skuImageUrl ? { skuImageUrl: sku.skuImageUrl } : {}),
    ...(sku.unitName ? { unitName: sku.unitName } : {}),
    ...(sku.barCode ? { barCode: sku.barCode } : {}),
    ...(sku.weight ? { weight: sku.weight } : {}),
    ...(sku.volume ? { volume: sku.volume } : {}),
  };
}

/**
 * What each checkout rule took off one line — the preview's `adjustments`,
 * split per line — for the order reads. Without it an activity order with a
 * coupon stacked on it cannot tell the activity from the coupon: both fold into
 * `discountAmount`. A rule that left this line alone is not listed.
 */
function lineAdjustmentsOf(
  discount: DiscountSplit,
  index: number,
): NonNullable<OrderItemSnapshot['adjustments']> {
  return discount.applied.flatMap((applied) => {
    const share = applied.perLine[index] ?? Money.ZERO;
    return share.isZero()
      ? []
      : [{ source: applied.source, label: applied.label, amount: share.toString() }];
  });
}

/**
 * The cost total, for the margin report. A variant with no recorded cost
 * contributes nothing rather than zero-ing the order: `orders.cost_amount` is
 * nullable precisely so "we do not know" is expressible.
 */
function costAmountOf(lines: readonly DraftLine[]): string | null {
  if (lines.every((line) => line.sku.costUnitPrice === null)) return null;
  return Money.sum(
    lines.map((line) => Money.parseOrZero(line.sku.costUnitPrice).mul(line.quantity)),
  ).toString();
}

export async function create(ctx: Ctx, body: CheckoutCreateBody): Promise<OrderDetail> {
  const userId = requireUserId(ctx);
  const now = ctx.clock.now();

  // The ordinary replay — the shopper's second tap, a retried request — arrives
  // long after the first one emptied the cart, so it would fail on `ORDER_EMPTY`
  // before the index could refuse it. This read answers it with the order it
  // already made. It is a fast path and nothing more: it takes no lock, and the
  // simultaneous case below is still decided by `orders_idempotency_uq`.
  const replayed = await repo.findOrderIdByIdempotencyKey(ctx.db, {
    userId,
    key: body.idempotencyKey,
  });
  if (replayed !== null) return detailOf(ctx, { orderId: replayed, userId });

  const submit = () =>
    ctx.withTx(async (tx) => {
      const draft = await buildDraft(ctx, tx, userId, body);
      if (draft.addressRequired && draft.address === null) {
        throw new DomainError('ORDER_ADDRESS_REQUIRED');
      }
      assertCustomFormComplete(draft, body.customForm);

      // Group-buy and presale attach here rather than forking this service.
      const handler = getOrderKindHandler(body.kind);
      if (body.kind !== 'normal' && !handler) {
        throw new DomainError('VALIDATION_FAILED', {
          message: '该订单类型暂不可用',
          details: { kind: body.kind },
        });
      }
      const kindMeta = handler
        ? await handler.beforeCreate(ctx, tx, {
            userId,
            lines: draft.lines.map(pricingLineOf),
            goodsTotal: draft.itemsAmount,
            selections: kindSelections(body),
            // The handler needs to know its own adjustment reached the order,
            // and `create` is holding the answer at this very moment. Without
            // it a kind handler has to re-run its own contributor inside this
            // open transaction — a second pooled connection per checkout, which
            // deadlocks the pool as soon as as many orders are placed at once
            // as the pool is wide.
            adjustments: draft.discount.applied,
          })
        : {};

      // After the kind handler, never before it: an activity that has ended
      // drops its price from the draft, and the shopper must hear 「活动已结束」
      // rather than a 「价格有变动」 that sends them back to pay full price.
      if (body.expectedPayableAmount !== undefined) {
        const expected = Money.parse(body.expectedPayableAmount);
        if (!expected.eq(draft.payableAmount)) {
          throw new DomainError('ORDER_PRICE_CHANGED', {
            details: { expected: expected.toString(), actual: draft.payableAmount.toString() },
          });
        }
      }

      const address = draft.address;
      const order = await repo.insertOrder(tx, {
        orderNo: generateOrderNo(ctx.clock),
        userId,
        // The whole duplicate-submit defence: `orders_idempotency_uq` blocks a
        // concurrent twin here and raises 23505 once the first one commits.
        idempotencyKey: body.idempotencyKey,
        kind: body.kind,
        status: 'pending_payment',
        platform: PLATFORM[ctx.platform ?? 'h5'] ?? 'h5',
        totalQuantity: draft.lines.reduce((sum, line) => sum + line.quantity, 0),
        itemsAmount: draft.itemsAmount.toString(),
        freightAmount: draft.freightAmount.toString(),
        couponDiscount: draft.discount.total.toString(),
        payableAmount: draft.payableAmount.toString(),
        costAmount: costAmountOf(draft.lines),
        userCouponId: draft.userCouponId,
        receiverName: address?.receiverName ?? '',
        receiverPhone: address?.receiverPhone ?? '',
        receiverProvince: address?.provinceName ?? '',
        receiverCity: address?.cityName ?? '',
        receiverDistrict: address?.districtName ?? null,
        receiverDetail: address?.detail ?? '',
        receiverPostCode: address?.postCode ?? null,
        receiverCityId: address?.cityId ?? null,
        buyerRemark: body.buyerRemark ?? null,
        customForm: body.customForm ?? null,
        payExpiresAt: new Date(now.getTime() + draft.payWindowMinutes * 60_000),
      });

      await repo.insertOrderItems(
        tx,
        draft.lines.map((line, index) => {
          const share = draft.discount.perLine[index] ?? Money.ZERO;
          return {
            orderId: order.id,
            productId: line.sku.productId,
            skuId: line.sku.skuId,
            itemKey: line.itemKey,
            quantity: line.quantity,
            unitPrice: line.unitPrice.toString(),
            originalUnitPrice: line.sku.originalUnitPrice,
            costUnitPrice: line.sku.costUnitPrice,
            discountAmount: share.toString(),
            totalAmount: line.subtotal.sub(share).toString(),
            snapshot: {
              ...snapshotOf(line.sku),
              adjustments: lineAdjustmentsOf(draft.discount, index),
            },
          };
        }),
      );

      // One conditional statement per line. The loser of a last-unit race gets
      // the line back here, not a negative stock and a CHECK violation.
      const stockLines: StockLine[] = draft.lines.map((line) => ({
        skuId: line.sku.skuId,
        quantity: line.quantity,
      }));
      // `ctx` lets the catalog record 库存预警 for a SKU this reservation
      // pushed under its threshold, in this transaction.
      const short = await resolveStockPort().reserve(tx, order.id, stockLines, ctx);
      if (short.length > 0) {
        throw new DomainError('ORDER_OUT_OF_STOCK', {
          details: {
            lines: short.map((line) => ({ skuId: toId(line.skuId), wanted: line.quantity })),
          },
        });
      }

      // Spending the coupon belongs in the order's own transaction: pricing
      // must not write, and a redemption must not survive a rolled-back order.
      if (draft.userCouponId !== null) {
        await coupon.redeem(tx, ctx, {
          userCouponId: draft.userCouponId,
          userId,
          orderId: order.id,
        });
      }

      if (handler) await handler.afterCreate(ctx, tx, order.id, kindMeta);

      await repo.deleteCartLines(tx, { userId, cartItemIds: draft.cartItemIds });
      await repo.insertStatusLog(tx, {
        orderId: order.id,
        changeType: 'created',
        toStatus: 'pending_payment',
        operatorKind: 'user',
        operatorUserId: userId,
        message: `提交订单，应付 ${draft.payableAmount.toString()}`,
      });

      // Inside this transaction, so a submit that rolls back on stock or on a
      // coupon leaves no 订单提交成功 behind; `notify` only writes an effect
      // row and the dispatcher fans out after the commit, so no channel can
      // fail a checkout. The return value is not an error signal — `false`
      // would mean this order was already announced, which is the outcome
      // either way, and the replay path above never reaches here at all.
      const announcement = {
        orderId: order.id,
        orderNo: order.orderNo,
        amount: draft.payableAmount.toString(),
      };
      await notify(tx, ctx, {
        event: 'order_created',
        subject: { scope: 'order', id: order.id },
        userId,
        data: announcement,
      });
      await notify(tx, ctx, {
        event: 'admin_order_created',
        subject: { scope: 'order', id: order.id },
        data: announcement,
      });

      // A coupon that covered the whole order leaves nothing to collect, and
      // WeChat Pay cannot take 0: the order is paid now, in this transaction.
      const payment = resolvePaymentPort();
      if (draft.payableAmount.isZero() && payment?.settleZeroAmountOrder) {
        await payment.settleZeroAmountOrder(tx, ctx, order.id);
        return {
          orderId: order.id,
          replayed: false,
          payWindowMinutes: 0,
          remindAfterMinutes: null,
        };
      }

      return {
        orderId: order.id,
        replayed: false,
        payWindowMinutes: draft.payWindowMinutes,
        remindAfterMinutes: unpaidReminderDelayMinutes(
          draft.payWindowMinutes,
          draft.unpaidReminderMinutes,
        ),
      };
    });

  // The replay. A concurrent twin blocks on the index entry until this
  // transaction settles, so by the time the violation surfaces the winner has
  // committed and its order is readable; a submit that *failed* leaves a dead
  // index entry, which is what lets the same key be tried again.
  //
  // Not only on the violation: a twin that read the key before the winner
  // committed but reads the cart after it finds the cart already emptied and
  // fails on `ORDER_EMPTY` — before its insert, so the index never gets to
  // refuse it. Whatever this attempt failed on, an order carrying the key
  // means the submit succeeded, and the answer is that order.
  const outcome = await submit().catch(async (error: unknown) => {
    const existing = await repo.findOrderIdByIdempotencyKey(ctx.db, {
      userId,
      key: body.idempotencyKey,
    });
    if (existing === null) throw error;
    return { orderId: existing, replayed: true, payWindowMinutes: 0, remindAfterMinutes: null };
  });

  // After the commit: a queue is not transactional, and an enqueue inside the
  // transaction can be delivered before — or without — the row it refers to.
  // A replay, or a zero-amount order checkout already paid (window 0), has
  // nothing to cancel and nothing to remind about.
  if (!outcome.replayed && outcome.payWindowMinutes > 0) {
    const delay = outcome.payWindowMinutes * 60_000;
    await ctx.queue.enqueue(
      AUTO_CANCEL_JOB,
      { orderId: toId(outcome.orderId) },
      { delay, dedupeKey: autoCancelKey(outcome.orderId) },
    );
  }
  if (!outcome.replayed && outcome.remindAfterMinutes !== null) {
    await ctx.queue.enqueue(
      UNPAID_REMINDER_JOB,
      { orderId: toId(outcome.orderId) },
      {
        delay: outcome.remindAfterMinutes * 60_000,
        dedupeKey: unpaidReminderKey(outcome.orderId),
      },
    );
  }

  return detailOf(ctx, { orderId: outcome.orderId, userId });
}

/**
 * The lines 再次购买 puts back into the cart. Lives here rather than in the
 * cart domain because it reads `order_items`; the cart calls it through
 * `order/index.ts`.
 */
export async function rebuyLines(
  ctx: Ctx,
  input: { orderId: number; userId: number },
): Promise<{ skuId: number; quantity: number }[]> {
  const order = await repo.findOrderForUser(ctx.db, { id: input.orderId, userId: input.userId });
  if (!order) throw new DomainError('ORDER_NOT_FOUND');
  const items = await repo.listItems(ctx.db, [order.id]);
  return items.map((item) => ({ skuId: item.skuId, quantity: item.quantity }));
}
