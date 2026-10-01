import type { ClientPlatform } from '@shop/contracts/conventions';
import type { OrderItem } from '@shop/contracts/order/schemas';
import type {
  AdminOrderDetail,
  AdminOrderListItem,
  AdminOrderListQuery,
  OrderAddressBody,
  OrderDeletionsBody,
  OrderDeletionsResult,
  OrderExportQuery,
  OrderExportResult,
  OrderPriceBody,
  OrderRemarkBody,
  OrderStatistics,
  OrderStatisticsQuery,
  OrderTimeline,
  Shipment,
} from '@shop/contracts/order/order.fulfil.schemas';
import type { DbOrTx } from '@shop/db';
import { hasPermission } from '../auth/rbac';
import { requireAdminId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import { Money } from '../kernel/money';
import { SHOP_DAY_MS, shopDateTime, shopDay, shopDayStart } from '../kernel/shop-time';
import { notify } from '../notification';
import { maskPhone } from '../user';
import { closeOrderPayments, openPaymentState } from './order.cancel.service';
import { kindStatesFor, type OrderKindState, type PaymentState } from './ports';
import { orderFulfilConfig } from './order.fulfil.config';
import { orderPermissions } from './permissions';
import * as fulfilRepo from './order.fulfil.repo';
import * as rules from './order.fulfil.rules';
import { distribute } from './order.pricing';
import { receiveOrder, shipmentContextFor, toWireShipment } from './order.fulfil.service';
import * as repo from './order.repo';

/**
 * The admin order console.
 *
 * This file plus `order.fulfil.service.ts` is the whole console. Two design
 * points matter:
 *
 *  - **The filter set is orthogonal.** Every axis (status, payment, refund
 *    state, deletion) is its own query key and the tab bar is a preset over
 *    them, so 已退款 and 待收货 can be asked for together; one combined status
 *    code could not express that.
 *  - **改价 recomputes rather than overwrites.** The operator names a discount;
 *    `orders.payable_amount` and every `order_items.discount_amount` are
 *    derived from it with checkout's own arithmetic, so a later partial refund
 *    reads a line share that is still correct. Writing the operator's total
 *    onto the order alone would leave the line shares stale.
 */

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** `orders_platform` (underscores) back to `X-Client-Platform` (hyphens). Checkout owns the forward map. */
const PLATFORM: Record<string, ClientPlatform> = {
  h5: 'h5',
  wechat_oa: 'wechat-oa',
  wechat_mini: 'wechat-mini',
};

// ---------------------------------------------------------------------------
// row -> wire
// ---------------------------------------------------------------------------

function toOrderItem(row: repo.OrderItemRow): OrderItem {
  const snapshot = row.snapshot;
  return {
    id: toId(row.id),
    itemKey: row.itemKey,
    productId: toId(row.productId),
    skuId: toId(row.skuId),
    productName: snapshot.productName,
    productImageUrl: snapshot.productImageUrl,
    productKind: snapshot.productKind,
    specText: snapshot.specText,
    skuImageUrl: snapshot.skuImageUrl ?? null,
    unitName: snapshot.unitName ?? null,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    originalUnitPrice: row.originalUnitPrice,
    discountAmount: row.discountAmount,
    totalAmount: row.totalAmount,
    refundedQuantity: row.refundedQuantity,
    shippedQuantity: row.shippedQuantity,
    // Written at create; a line whose snapshot has no `adjustments` shows none.
    adjustments: snapshot.adjustments ?? [],
  };
}

export interface ConsoleSideData {
  users: Map<number, fulfilRepo.UserBriefRow>;
  /** The newest invoice request per order; the console shows its status as a column. */
  invoices: Map<number, 'requested' | 'issued' | 'rejected' | 'cancelled'>;
  /** Each kind's own state (the 拼团 team), from the kind's domain through the port. */
  kindStates: Map<number, OrderKindState>;
}

async function sideDataFor(
  db: DbOrTx,
  rows: readonly fulfilRepo.OrderRow[],
): Promise<ConsoleSideData> {
  const orderIds = rows.map((row) => row.id);
  const [users, invoices, kindStates] = await Promise.all([
    fulfilRepo.listUserBriefs(
      db,
      rows.map((row) => row.userId),
    ),
    fulfilRepo.listOpenInvoiceStatuses(db, orderIds),
    kindStatesFor(db, rows),
  ]);
  const invoiceByOrder = new Map<number, 'requested' | 'issued' | 'rejected' | 'cancelled'>();
  // Ordered newest first by the repo, so the first one wins.
  for (const row of invoices) {
    if (!invoiceByOrder.has(row.orderId)) invoiceByOrder.set(row.orderId, row.status);
  }
  return {
    users: new Map(users.map((user) => [user.id, user])),
    invoices: invoiceByOrder,
    kindStates,
  };
}

export function toAdminListItem(
  row: repo.OrderRow,
  items: OrderItem[],
  side: ConsoleSideData,
): AdminOrderListItem {
  const user = side.users.get(row.userId);
  return {
    id: toId(row.id),
    orderNo: row.orderNo,
    kind: row.kind,
    status: row.status,
    fulfillmentStatus: row.fulfillmentStatus,
    refundStatus: row.refundStatus,
    totalQuantity: row.totalQuantity,
    itemsAmount: row.itemsAmount,
    freightAmount: row.freightAmount,
    couponDiscount: row.couponDiscount,
    payableAmount: row.payableAmount,
    paidAmount: row.paidAmount,
    payExpiresAt: row.status === 'pending_payment' ? iso(row.payExpiresAt) : null,
    createdAt: row.createdAt.toISOString(),
    items,
    platform: PLATFORM[row.platform] ?? 'h5',
    user: {
      id: toId(row.userId),
      // A deleted user leaves the order behind; the console still has to render it.
      nickname: user?.nickname ?? `用户 ${row.userId}`,
      avatarUrl: user?.avatarUrl ?? null,
      phone: user?.phone ?? null,
    },
    receiver: {
      addressId: null,
      name: row.receiverName,
      phone: row.receiverPhone,
      province: row.receiverProvince,
      city: row.receiverCity,
      district: row.receiverDistrict,
      detail: row.receiverDetail,
      postCode: row.receiverPostCode,
    },
    refundedAmount: row.refundedAmount,
    buyerRemark: row.buyerRemark,
    adminRemark: row.adminRemark,
    invoiceStatus: side.invoices.get(row.id) ?? null,
    groupbuyTeamStatus: side.kindStates.get(row.id)?.groupbuyTeam?.status ?? null,
    paidAt: iso(row.paidAt),
    shippedAt: iso(row.shippedAt),
    receivedAt: iso(row.receivedAt),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    deletedAt: iso(row.deletedAt),
  };
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value as T];

const asDate = (value: string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(value);

export function filterOf(query: AdminOrderListQuery): fulfilRepo.AdminOrderFilter {
  return {
    status: asArray(query.status),
    fulfillmentStatus: asArray(query.fulfillmentStatus),
    refundStatus: asArray(query.refundStatus),
    refunding: query.refunding,
    kind: query.kind,
    platform: query.platform === undefined ? undefined : PLATFORM_TO_DB[query.platform],
    keyword: query.keyword,
    userId: query.userId === undefined ? undefined : fromId(query.userId),
    createdFrom: asDate(query.createdFrom),
    createdTo: asDate(query.createdTo),
    paidFrom: asDate(query.paidFrom),
    paidTo: asDate(query.paidTo),
    deleted: query.deleted,
  };
}

const PLATFORM_TO_DB: Record<ClientPlatform, 'h5' | 'wechat_oa' | 'wechat_mini'> = {
  h5: 'h5',
  'wechat-oa': 'wechat_oa',
  'wechat-mini': 'wechat_mini',
};

export async function adminList(
  ctx: Ctx,
  query: AdminOrderListQuery,
): Promise<{ items: AdminOrderListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await fulfilRepo.listAdminOrders(ctx.db, {
    filter: filterOf(query),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });

  const items = await repo.listItems(
    ctx.db,
    rows.map((row) => row.id),
  );
  const byOrder = new Map<number, OrderItem[]>();
  for (const item of items) {
    const list = byOrder.get(item.orderId);
    const mapped = toOrderItem(item);
    if (list) list.push(mapped);
    else byOrder.set(item.orderId, [mapped]);
  }
  const side = await sideDataFor(ctx.db, rows);

  return {
    // The account phone is masked in a list, as the customer list is: a screenshot of a table
    // should not leak it. The order detail's 客户信息 shows it whole.
    items: rows.map((row) => {
      const item = toAdminListItem(row, byOrder.get(row.id) ?? [], side);
      return { ...item, user: { ...item.user, phone: maskPhone(item.user.phone) } };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// one order
// ---------------------------------------------------------------------------

async function loadOrder(ctx: Ctx, id: string): Promise<repo.OrderRow> {
  const row = await repo.findOrder(ctx.db, fromId(id));
  if (!row) throw new DomainError('ORDER_NOT_FOUND');
  return row;
}

export async function adminDetail(ctx: Ctx, params: { id: string }): Promise<AdminOrderDetail> {
  const row = await loadOrder(ctx, params.id);
  const items = await repo.listItems(ctx.db, [row.id]);
  const side = await sideDataFor(ctx.db, [row]);

  const shipmentRows = await fulfilRepo.listShipments(ctx.db, [row.id]);
  const shipmentLines = await fulfilRepo.listShipmentItems(
    ctx.db,
    shipmentRows.map((shipment) => shipment.id),
  );
  const shipmentContext = await shipmentContextFor(ctx, [row.id], shipmentRows);
  const refundIds = await fulfilRepo.listRefundIds(ctx.db, [row.id]);

  return {
    ...toAdminListItem(row, items.map(toOrderItem), side),
    customForm: row.customForm,
    userCouponId: toIdOrNull(row.userCouponId),
    cancelReason: row.cancelReason,
    costAmount: seesCost(ctx) ? row.costAmount : null,
    operatorDiscount: row.operatorDiscount,
    transactionNo: row.transactionNo,
    autoReceiveAt: iso(row.autoReceiveAt),
    shipments: shipmentRows.map((shipment) =>
      toWireShipment(shipment, shipmentLines, shipmentContext),
    ),
    refundIds: refundIds.map((refund) => toId(refund.id)),
  };
}

/**
 * 成本 is the shop's margin, and catalog's rule for 成本价 holds here too: a
 * role that works orders (`order:write`) or takes them out of the building
 * (`order:export`) sees it; a role that may only look orders up (support,
 * say) gets `null`, which the console already renders as "no cost recorded".
 */
function seesCost(ctx: Ctx): boolean {
  return (
    hasPermission(ctx.actor, orderPermissions['order:write']) ||
    hasPermission(ctx.actor, orderPermissions['order:export'])
  );
}

export async function adminTimeline(ctx: Ctx, params: { id: string }): Promise<OrderTimeline> {
  const orderId = fromId(params.id);
  const rows = await fulfilRepo.listStatusLogs(ctx.db, orderId);
  return {
    items: rows.map((row) => ({
      id: toId(row.id),
      changeType: row.changeType,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      message: row.message,
      operatorKind: row.operatorKind,
      operatorName: row.operatorName,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function adminShipments(
  ctx: Ctx,
  params: { id: string },
): Promise<{ items: Shipment[] }> {
  const row = await loadOrder(ctx, params.id);
  const shipmentRows = await fulfilRepo.listShipments(ctx.db, [row.id]);
  const lines = await fulfilRepo.listShipmentItems(
    ctx.db,
    shipmentRows.map((shipment) => shipment.id),
  );
  const context = await shipmentContextFor(ctx, [row.id], shipmentRows);
  return { items: shipmentRows.map((shipment) => toWireShipment(shipment, lines, context)) };
}

// ---------------------------------------------------------------------------
// who is acting
// ---------------------------------------------------------------------------

/** The log fields a console action is attributed with, spread straight into `insertStatusLog`. */
export interface ConsoleOperator {
  operatorKind: 'admin';
  operatorAdminId: number;
}

/**
 * Who the timeline names for a console action: the signed-in operator. Every
 * route that reaches these services is `auth: 'admin'`. (The mobile staff
 * console came in as a `user` actor and was deleted at the cutover; the log
 * rows it wrote keep `operator_kind = 'user'` and still read back.)
 */
export function operatorOf(ctx: Ctx): ConsoleOperator {
  if (ctx.actor.kind === 'admin') {
    return { operatorKind: 'admin', operatorAdminId: requireAdminId(ctx) };
  }
  throw new DomainError('UNAUTHENTICATED');
}

// ---------------------------------------------------------------------------
// console actions
// ---------------------------------------------------------------------------

export async function adminRemark(
  ctx: Ctx,
  params: { id: string },
  body: OrderRemarkBody,
): Promise<AdminOrderDetail> {
  const operator = operatorOf(ctx);
  const orderId = fromId(params.id);

  await ctx.withTx(async (tx) => {
    const updated = await fulfilRepo.setAdminRemark(tx, { orderId, remark: body.adminRemark });
    if (!updated.won) throw new DomainError('ORDER_NOT_FOUND');
    await repo.insertStatusLog(tx, {
      orderId,
      changeType: 'remark_updated',
      message: body.adminRemark.slice(0, 512),
      ...operator,
    });
  });

  return adminDetail(ctx, params);
}

/**
 * 改价, before payment only.
 *
 * `status = 'pending_payment'` is in the WHERE of `applyRepricing`, so a
 * payment that landed while the form was open makes this affect zero rows and
 * the operator is told — rather than the system quietly rewriting the price of
 * an order somebody has already paid for.
 *
 * The buyer may already hold a payment for the old amount. It is closed first,
 * with the cancel path's two-call protocol: `closeOrderPayments` at the gateway
 * outside the transaction, `openPaymentState` again under the order lock. Money
 * that arrived meanwhile refuses the change; a close the gateway did not
 * confirm refuses it too, because that payment could still land at the old price.
 *
 * The operator's discount **replaces** the previous one (kept on
 * `orders.operator_discount`), so the form means what it says and 0.00 undoes.
 */
/** `paid`: the money is in, so the price is final. `unknown`: it still might be. */
/**
 * What checkout took off each line, without the last 改价.
 *
 * Before any 改价 that is the line's `discount_amount`. After one, it is the line's own
 * checkout adjustments (the snapshot keeps them per line since the adjustments release). An
 * order written before that, repriced once and still unpaid, has no per-line record: its
 * checkout discount is spread by line subtotal, as 改价 always used to.
 */
export function checkoutShares(
  items: readonly repo.OrderItemRow[],
  operatorDiscount: string,
): Money[] {
  const current = items.map((item) => Money.parse(item.discountAmount));
  const previous = Money.parse(operatorDiscount);
  if (previous.isZero()) return current;
  if (items.every((item) => item.snapshot.adjustments !== undefined)) {
    return items.map((item) =>
      Money.sum((item.snapshot.adjustments ?? []).map((a) => Money.parse(a.amount).abs())),
    );
  }
  const checkoutTotal = Money.sum(current).sub(previous).clampToZero();
  return distribute(
    checkoutTotal,
    items.map((item) => Money.parse(item.unitPrice).mul(item.quantity)),
  );
}

function refuseRepriceOn(state: PaymentState): void {
  if (state === 'paid') throw new DomainError('ORDER_PRICE_NOT_ADJUSTABLE');
  if (state === 'unknown') throw new DomainError('ORDER_PAYMENT_STATE_UNKNOWN');
}

export async function adminAdjustPrice(
  ctx: Ctx,
  params: { id: string },
  body: OrderPriceBody,
): Promise<AdminOrderDetail> {
  const operator = operatorOf(ctx);
  const orderId = fromId(params.id);

  refuseRepriceOn(await closeOrderPayments(ctx, orderId));

  await ctx.withTx(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new DomainError('ORDER_NOT_FOUND');
    if (order.status !== 'pending_payment') {
      throw new DomainError('ORDER_PRICE_NOT_ADJUSTABLE', { details: { status: order.status } });
    }
    // A payment started after the close above is open again: same refusal.
    refuseRepriceOn(await openPaymentState(ctx, tx, orderId));

    const items = await repo.listItems(tx, [orderId]);
    // Checkout's goods-level discounts stay on their lines (ORDER-012); only the
    // last 改价 is taken out before the new one goes on.
    const shares = checkoutShares(items, order.operatorDiscount);
    const outcome = rules.reprice({
      lines: items.map((item, index) => ({
        orderItemId: item.id,
        quantity: item.quantity,
        unitPrice: Money.parse(item.unitPrice),
        checkoutDiscount: shares[index] ?? Money.ZERO,
      })),
      freightAmount: Money.parse(body.freightAmount ?? order.freightAmount),
      operatorDiscount: Money.parse(body.operatorDiscount),
    });
    if (outcome.kind === 'too-large') {
      throw new DomainError('ORDER_PRICE_INVALID', {
        details: { maximum: outcome.maximum.toString() },
      });
    }

    const applied = await fulfilRepo.applyRepricing(tx, {
      orderId,
      freightAmount: outcome.freightAmount.toString(),
      couponDiscount: outcome.couponDiscount.toString(),
      operatorDiscount: Money.parse(body.operatorDiscount).toString(),
      payableAmount: outcome.payableAmount.toString(),
    });
    if (!applied.won) throw new DomainError('ORDER_PRICE_NOT_ADJUSTABLE');

    for (const line of outcome.lines) {
      await fulfilRepo.setItemDiscount(tx, {
        orderItemId: line.orderItemId,
        discountAmount: line.discountAmount.toString(),
        totalAmount: line.totalAmount.toString(),
      });
    }

    await repo.insertStatusLog(tx, {
      orderId,
      changeType: 'price_adjusted',
      message: `改价 ${order.payableAmount} -> ${outcome.payableAmount.toString()}${
        body.reason ? ` (${body.reason})` : ''
      }`.slice(0, 512),
      ...operator,
    });

    // The buyer has to be told the amount moved, or they pay the old one and
    // the order sticks. Inside the transaction: an operator whose repricing
    // lost the race against a payment (`applied.won === false` above) must not
    // have sent 订单金额已修改 for a price that never changed. `oldAmount`
    // comes from the locked row read before the update, so it is the amount the
    // buyer actually saw.
    //
    // The subject carries the **resulting amount**, not just the order id, for
    // the same reason two partial refunds of one order need two keys. An order
    // is legitimately repriced more than once — each 改价 replaces the last
    // one — so a per-order key would deduplicate every
    // change after the first into silence. Keyed on the amount, a save that
    // leaves the total where it was is the one thing that notifies once.
    await notify(tx, ctx, {
      event: 'order_price_changed',
      subject: { scope: 'order-price', id: `${orderId}:${outcome.payableAmount.toString()}` },
      userId: order.userId,
      data: {
        orderId,
        orderNo: order.orderNo,
        oldAmount: order.payableAmount,
        amount: outcome.payableAmount.toString(),
      },
    });
  });

  return adminDetail(ctx, params);
}

/**
 * 修改收货地址.
 *
 * Allowed while nothing has gone out. `updateReceiver`'s WHERE carries both
 * halves — status in (`pending_payment`, `paid`) *and*
 * `fulfillment_status = 'unfulfilled'` — so a dispatch committed between the
 * operator opening the form and pressing save wins, and the parcel's label
 * still matches the order.
 */
export async function adminUpdateAddress(
  ctx: Ctx,
  params: { id: string },
  body: OrderAddressBody,
): Promise<AdminOrderDetail> {
  const operator = operatorOf(ctx);
  const orderId = fromId(params.id);

  await ctx.withTx(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new DomainError('ORDER_NOT_FOUND');

    const updated = await fulfilRepo.updateReceiver(tx, {
      orderId,
      set: {
        receiverName: body.name,
        receiverPhone: body.phone,
        receiverProvince: body.province,
        receiverCity: body.city,
        receiverDistrict: body.district ?? null,
        receiverDetail: body.detail,
        receiverPostCode: body.postCode ?? null,
      },
    });
    if (!updated.won) throw new DomainError('ORDER_ADDRESS_NOT_EDITABLE');

    await repo.insertStatusLog(tx, {
      orderId,
      changeType: 'address_updated',
      message:
        `修改收货地址为 ${body.name} ${body.phone} ${body.province}${body.city}${body.detail}`.slice(
          0,
          512,
        ),
      ...operator,
    });
  });

  return adminDetail(ctx, params);
}

/** 确认收货, from the console. The same conditional transition the buyer's button runs. */
export async function adminConfirmReceipt(
  ctx: Ctx,
  params: { id: string },
): Promise<AdminOrderDetail> {
  const adminId = requireAdminId(ctx);
  await receiveOrder(ctx, {
    orderId: fromId(params.id),
    by: 'admin',
    operatorAdminId: adminId,
    strict: true,
  });
  return adminDetail(ctx, params);
}

export const OPEN_REFUND_BLOCKS_DELETE = '订单还有售后在处理，处理完后才能删除';

/**
 * 删除订单 — a soft delete, and only of a finished order.
 *
 * Removing a `paid` order from every list would leave its stock, its coupon and
 * its money committed with nobody looking at them. So the WHERE says
 * `cancelled | completed | refunded`, and an order in flight cannot be made to
 * disappear. Nor can a 已完成 order whose after-sales request is still open:
 * the refund would go on with the order gone from every list.
 */
export async function adminDelete(ctx: Ctx, params: { id: string }): Promise<{ deleted: boolean }> {
  const adminId = requireAdminId(ctx);
  const orderId = fromId(params.id);

  return ctx.withTx(async (tx) => {
    const order = await repo.findOrder(tx, orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND');
    const deleted = await fulfilRepo.softDeleteOrder(tx, { orderId, at: ctx.clock.now() });
    if (!deleted.won) {
      if (order.deletedAt === null && (await repo.orderHasOpenRefund(tx, orderId))) {
        throw new DomainError('ORDER_NOT_DELETABLE', {
          message: OPEN_REFUND_BLOCKS_DELETE,
          details: { status: order.status, openRefund: true },
        });
      }
      throw new DomainError('ORDER_NOT_DELETABLE', { details: { status: order.status } });
    }
    await repo.insertStatusLog(tx, {
      orderId,
      changeType: 'deleted_by_admin',
      message: '后台删除订单',
      operatorKind: 'admin',
      operatorAdminId: adminId,
    });
    return { deleted: true };
  });
}

/**
 * The batch. Unlike the single-order route this *skips* what it cannot delete
 * rather than failing the lot: an operator who ticked forty rows wants the
 * thirty-eight finished ones filed away and a list of the two that are not.
 */
export async function adminDeleteMany(
  ctx: Ctx,
  body: OrderDeletionsBody,
): Promise<OrderDeletionsResult> {
  const adminId = requireAdminId(ctx);
  const at = ctx.clock.now();
  const ids = [...new Set(body.ids.map(fromId))];

  return ctx.withTx(async (tx) => {
    const skippedIds: string[] = [];
    let deleted = 0;
    for (const orderId of ids) {
      const result = await fulfilRepo.softDeleteOrder(tx, { orderId, at });
      if (!result.won) {
        skippedIds.push(toId(orderId));
        continue;
      }
      deleted += 1;
      await repo.insertStatusLog(tx, {
        orderId,
        changeType: 'deleted_by_admin',
        message: '后台批量删除订单',
        operatorKind: 'admin',
        operatorAdminId: adminId,
      });
    }
    return { deleted, skippedIds };
  });
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/**
 * The window in whole Shanghai days, as 交易统计 draws it: `to` is exclusive
 * and opens the day after the last one, and the default is today and the 29
 * days before — so 近 30 天实付 here and 支付金额 there are the same number.
 */
export function windowOf(now: Date, query: OrderStatisticsQuery): { from: Date; to: Date } {
  const to = new Date(
    shopDayStart(query.to === undefined ? now : new Date(query.to)).getTime() + SHOP_DAY_MS,
  );
  const from =
    query.from === undefined
      ? new Date(to.getTime() - 30 * SHOP_DAY_MS)
      : shopDayStart(new Date(query.from));
  return { from, to };
}

export async function adminStatistics(
  ctx: Ctx,
  query: OrderStatisticsQuery,
): Promise<OrderStatistics> {
  const range = windowOf(ctx.clock.now(), query);
  const [queue, totals] = await Promise.all([
    fulfilRepo.workQueueCounts(ctx.db),
    fulfilRepo.rangeTotals(ctx.db, range),
  ]);
  return {
    pendingShipment: queue.pendingShipment,
    pendingReceipt: queue.pendingReceipt,
    refunding: queue.refunding,
    pendingInvoice: queue.pendingInvoice,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    orderCount: totals.orderCount,
    paidOrderCount: totals.paidOrderCount,
    // `sum()` of numeric comes back unpadded ("0", "5320.0"); the wire wants
    // two fraction digits and `Money` is the one thing that guarantees them.
    paidAmount: Money.parse(padded(totals.paidAmount)).toString(),
    refundedAmount: Money.parse(padded(totals.refundedAmount)).toString(),
  };
}

/** `"0"` and `"5320.5"` both have to become something `Money.parse` accepts. */
function padded(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const ORDER_HEADER = [
  '订单号',
  '下单时间',
  '状态',
  '发货状态',
  '售后状态',
  '买家',
  '收货人',
  '收货电话',
  '收货地址',
  '商品件数',
  '商品金额',
  '运费',
  '优惠',
  '应付',
  '实付',
  '已退款',
  '支付时间',
  '发货时间',
  '买家备注',
  '商家备注',
] as const;

const SHIPMENT_HEADER = [
  '订单号',
  '发货单号',
  '发货方式',
  '发货状态',
  '物流公司',
  '运单号',
  '配送人',
  '配送电话',
  '商品',
  '规格',
  '数量',
  '发货时间',
] as const;

/**
 * 导出, as CSV text inside the JSON envelope.
 *
 * `handle()` validates every response against the contract, so a route cannot
 * answer with a binary stream; the kit turns `content` into a download on the
 * client. Bounded by `exportMaxRows` — an unbounded export of a shop's whole
 * order history can run the server out of memory.
 */
export async function adminExport(ctx: Ctx, query: OrderExportQuery): Promise<OrderExportResult> {
  const { exportMaxRows } = await ctx.config.get(orderFulfilConfig);
  const filter = filterOf({ ...query, page: 1, pageSize: 1 } as AdminOrderListQuery);
  const total = await fulfilRepo.countAdminOrders(ctx.db, filter);
  const rows = await fulfilRepo.listAdminOrdersForExport(ctx.db, {
    filter,
    limit: exportMaxRows,
  });
  const stamp = shopDay(ctx.clock.now());

  if (query.kindOfExport === 'shipments') {
    const shipments = await fulfilRepo.listShipments(
      ctx.db,
      rows.map((row) => row.id),
    );
    const lines = await fulfilRepo.listShipmentItems(
      ctx.db,
      shipments.map((shipment) => shipment.id),
    );
    const context = await shipmentContextFor(
      ctx,
      rows.map((row) => row.id),
      shipments,
    );
    const orderNo = new Map(rows.map((row) => [row.id, row.orderNo]));
    const body: (string | number | null)[][] = [];
    for (const shipment of shipments) {
      for (const line of lines.filter((item) => item.shipmentId === shipment.id)) {
        const item = context.items.get(line.orderItemId);
        body.push([
          orderNo.get(shipment.orderId) ?? '',
          shipment.shipmentNo,
          DELIVERY_MODE[shipment.deliveryMode] ?? shipment.deliveryMode,
          SHIPMENT_STATUS[shipment.status] ?? shipment.status,
          shipment.expressCompanyId === null
            ? ''
            : (context.companies.get(shipment.expressCompanyId) ?? ''),
          shipment.trackingNo,
          shipment.courierName,
          shipment.courierPhone,
          item?.snapshot.productName ?? '',
          item?.snapshot.specText ?? '',
          line.quantity,
          shopDateTime(shipment.dispatchedAt),
        ]);
      }
    }
    return {
      filename: `发货单-${stamp}.csv`,
      contentType: 'text/csv',
      rowCount: body.length,
      truncated: total > rows.length,
      content: rules.csvDocument(SHIPMENT_HEADER, body),
    };
  }

  const side = await sideDataFor(ctx.db, rows);
  const body = rows.map((row) => [
    row.orderNo,
    shopDateTime(row.createdAt),
    ORDER_STATUS[row.status] ?? row.status,
    FULFILLMENT_STATUS[row.fulfillmentStatus] ?? row.fulfillmentStatus,
    REFUND_STATUS[row.refundStatus] ?? row.refundStatus,
    side.users.get(row.userId)?.nickname ?? `用户 ${row.userId}`,
    row.receiverName,
    row.receiverPhone,
    `${row.receiverProvince}${row.receiverCity}${row.receiverDistrict ?? ''}${row.receiverDetail}`,
    row.totalQuantity,
    row.itemsAmount,
    row.freightAmount,
    row.couponDiscount,
    row.payableAmount,
    row.paidAmount ?? '',
    row.refundedAmount,
    row.paidAt === null ? '' : shopDateTime(row.paidAt),
    row.shippedAt === null ? '' : shopDateTime(row.shippedAt),
    row.buyerRemark ?? '',
    row.adminRemark ?? '',
  ]);

  return {
    filename: `订单-${stamp}.csv`,
    contentType: 'text/csv',
    rowCount: body.length,
    truncated: total > rows.length,
    content: rules.csvDocument(ORDER_HEADER, body),
  };
}

const ORDER_STATUS: Record<string, string> = {
  pending_payment: '待付款',
  paid: '待发货',
  shipped: '待收货',
  received: '已收货',
  completed: '已完成',
  cancelled: '已取消',
  refunded: '已退款',
};

const FULFILLMENT_STATUS: Record<string, string> = {
  unfulfilled: '未发货',
  partially_fulfilled: '部分发货',
  fulfilled: '已发货',
};

const REFUND_STATUS: Record<string, string> = {
  none: '无',
  requested: '退款中',
  partially_refunded: '部分退款',
  refunded: '已退款',
};

const DELIVERY_MODE: Record<string, string> = {
  express: '快递',
  merchant_delivery: '商家配送',
  virtual: '虚拟发货',
};

const SHIPMENT_STATUS: Record<string, string> = {
  dispatched: '已发货',
  delivered: '已签收',
  cancelled: '已撤销',
};
