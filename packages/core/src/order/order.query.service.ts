import type {
  OrderCounts,
  OrderDetail,
  OrderListQuery,
  OrderStatus,
  StorefrontOrderItem,
  StorefrontOrderListItem,
} from '@shop/contracts/order/schemas';
import type { UserCoupon } from '@shop/contracts/coupon/schemas';
import * as coupon from '../coupon';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { toId, toIdOrNull } from '../kernel/ids';
import { listOpenInvoiceStatuses } from './order.fulfil.repo';
import { invoiceableAmount, isInvoiceRequestable } from './order.invoice.service';
import { requireOrderRef } from './order.ref';
import * as repo from './order.repo';
import { getOrderKindHandler, kindStatesFor, type OrderKindState } from './ports';

/**
 * The buyer's own orders: the list, the tab badges and one order's detail.
 *
 * The only thing worth reading twice is `tabFilter`. The storefront's tabs are
 * *not* `orders.status` values — 待收货 covers `shipped`, 已完成 covers both
 * `received` and `completed` — and that mapping is written here, once, so the
 * list and the badges can never disagree about what 待发货 means.
 */

export async function list(
  ctx: Ctx,
  query: OrderListQuery,
): Promise<{ items: StorefrontOrderListItem[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const { rows, total } = await repo.listOrders(ctx.db, {
    userId,
    where: repo.tabFilter(query.tab),
    keyword: query.keyword,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });

  const items = await repo.listItems(
    ctx.db,
    rows.map((row) => row.id),
  );
  const reviewed = await repo.reviewedItemIds(
    ctx.db,
    items.map((item) => item.id),
  );
  const statusOf = new Map(rows.map((row) => [row.id, row.status]));
  const byOrder = new Map<number, StorefrontOrderItem[]>();
  for (const item of items) {
    const list = byOrder.get(item.orderId);
    const mapped = toOrderItem(item, statusOf.get(item.orderId), reviewed);
    if (list) list.push(mapped);
    else byOrder.set(item.orderId, [mapped]);
  }

  const states = await kindStatesFor(ctx.db, rows);
  const openRefund = await repo.ordersWithOpenRefund(
    ctx.db,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) =>
      toListItem(row, byOrder.get(row.id) ?? [], states.get(row.id), openRefund.has(row.id)),
    ),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The badges from one grouped query.
 *
 * `refunding` counts orders with an after-sales request still open, so an order can be in
 * two badges at once — which is what the tab bar has always shown, because an
 * order being refunded is still 待收货 until the refund succeeds. `unreviewed`
 * (待评价, ORDER-010) is likewise a subset of `finished`.
 */
export async function counts(ctx: Ctx): Promise<OrderCounts> {
  const userId = requireUserId(ctx);
  const rows = await repo.countByStatus(ctx.db, userId);

  const out: OrderCounts = {
    all: 0,
    unpaid: 0,
    unshipped: 0,
    unreceived: 0,
    finished: 0,
    cancelled: 0,
    refunding: 0,
    unreviewed: 0,
  };
  for (const row of rows) {
    out.all += row.n;
    out.unreviewed += row.unreviewed;
    out.refunding += row.refunding;
    switch (row.status) {
      case 'pending_payment':
        out.unpaid += row.n;
        break;
      case 'paid':
        out.unshipped += row.n;
        break;
      case 'shipped':
        out.unreceived += row.n;
        break;
      case 'received':
      case 'completed':
        out.finished += row.n;
        break;
      case 'cancelled':
        out.cancelled += row.n;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * The route-facing detail. A stranger and an unknown reference get the same
 * 404, and `:id` is the surrogate id or the order number.
 */
export async function detail(ctx: Ctx, params: { id: string }): Promise<OrderDetail> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);
  return detailOf(ctx, { orderId, userId });
}

/** Used by `create` and `cancel` to answer with the order they just changed. */
export async function detailOf(
  ctx: Ctx,
  input: { orderId: number; userId: number },
): Promise<OrderDetail> {
  const row = await repo.findOrderForUser(ctx.db, { id: input.orderId, userId: input.userId });
  if (!row) throw new DomainError('ORDER_NOT_FOUND');
  const items = await repo.listItems(ctx.db, [row.id]);
  const reviewed = await repo.reviewedItemIds(
    ctx.db,
    items.map((item) => item.id),
  );
  // The kind's own links (the 拼团 team) come from the kind's domain through the port: this
  // domain never reads a `groupbuy_*` table.
  const links = (await getOrderKindHandler(row.kind)?.detailLinks?.(ctx.db, row.id)) ?? {};
  const states = await kindStatesFor(ctx.db, [row]);
  const invoices = await listOpenInvoiceStatuses(ctx.db, [row.id]);
  const hasOpenInvoice = invoices.some((i) => i.status === 'requested' || i.status === 'issued');
  const openRefund = await repo.orderHasOpenRefund(ctx.db, row.id);
  return {
    ...toDetail(
      row,
      items.map((item) => toOrderItem(item, row.status, reviewed)),
      states.get(row.id),
      openRefund,
    ),
    groupbuyTeamId: toIdOrNull(links.groupbuyTeamId ?? null),
    invoiceRequestable: isInvoiceRequestable(row, hasOpenInvoice),
    invoiceAmount: invoiceableAmount(row).toString(),
  };
}

/**
 * 订单赠券 — the coupons this order earned.
 *
 * Lives here rather than in the coupon domain because the interesting half is
 * the *ownership* question, and this domain is the only one that may read
 * `orders`. The coupon domain is handed two integers.
 *
 * The order is loaded even though nothing on it is returned. `requireOrderRef`
 * only *resolves* the reference — an order number is looked up for this user,
 * but a bare surrogate id is taken at face value, because every caller so far
 * went on to read the order and find out. Skipping that read here would answer
 * a stranger `{ items: [] }` with a `200`: harmless-looking, and still the
 * difference between "no coupons" and "no such order of yours". The 404 says
 * neither.
 *
 * Keeping this a separate call rather than a field of the order detail means
 * the wallet-shaped part of the answer can change without widening
 * `OrderDetail`, and the 订单详情 page still renders while it is in flight.
 */
export async function giftCoupons(
  ctx: Ctx,
  params: { id: string },
): Promise<{ items: UserCoupon[] }> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);
  const order = await repo.findOrderForUser(ctx.db, { id: orderId, userId });
  if (!order) throw new DomainError('ORDER_NOT_FOUND');
  return coupon.listOrderGifts(ctx, { orderId, userId });
}

// ---------------------------------------------------------------------------
// row -> wire
// ---------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * ORDER-010: a line can be reviewed exactly when `catalog.reviewSubmit` would take it — the
 * order `received` or `completed` (`OrderFactsPort.findReviewableLine`), the line not refunded
 * in full, and no review yet (the unique index on `product_reviews.order_item_id`). The 待评价
 * count and tab say the same in SQL (`repo.awaitingReview`).
 */
export function isReviewable(
  status: OrderStatus,
  line: { quantity: number; refundedQuantity: number },
  reviewed: boolean,
): boolean {
  return (
    (status === 'received' || status === 'completed') &&
    line.refundedQuantity < line.quantity &&
    !reviewed
  );
}

function toOrderItem(
  row: repo.OrderItemRow,
  status: OrderStatus | undefined,
  reviewedIds: ReadonlySet<number>,
): StorefrontOrderItem {
  const snapshot = row.snapshot;
  const reviewed = reviewedIds.has(row.id);
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
    reviewed,
    reviewable: status !== undefined && isReviewable(status, row, reviewed),
  };
}

function toListItem(
  row: repo.OrderRow,
  items: StorefrontOrderItem[],
  state: OrderKindState | undefined,
  hasOpenRefund: boolean,
): StorefrontOrderListItem {
  const team = state?.groupbuyTeam;
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
    // The countdown only exists while the order can still be paid.
    payExpiresAt: row.status === 'pending_payment' ? iso(row.payExpiresAt) : null,
    createdAt: row.createdAt.toISOString(),
    items,
    refundedAmount: row.refundedAmount,
    hasOpenRefund,
    groupbuyTeam: team
      ? {
          id: toId(team.id),
          status: team.status,
          role: team.role,
          seatsTotal: team.seatsTotal,
          seatsTaken: team.seatsTaken,
          expiresAt: team.expiresAt.toISOString(),
        }
      : null,
  };
}

function toDetail(
  row: repo.OrderRow,
  items: StorefrontOrderItem[],
  state: OrderKindState | undefined,
  hasOpenRefund: boolean,
): Omit<OrderDetail, 'groupbuyTeamId' | 'invoiceRequestable' | 'invoiceAmount'> {
  return {
    ...toListItem(row, items, state, hasOpenRefund),
    receiver: {
      // The order carries a snapshot, not a link: editing the address book
      // later must never rewrite where an order was sent.
      addressId: null,
      name: row.receiverName,
      phone: row.receiverPhone,
      province: row.receiverProvince,
      city: row.receiverCity,
      district: row.receiverDistrict,
      detail: row.receiverDetail,
      postCode: row.receiverPostCode,
    },
    buyerRemark: row.buyerRemark,
    customForm: row.customForm,
    userCouponId: toIdOrNull(row.userCouponId),
    paidAt: iso(row.paidAt),
    shippedAt: iso(row.shippedAt),
    receivedAt: iso(row.receivedAt),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
  };
}
