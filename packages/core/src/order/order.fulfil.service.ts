import type { OrderDetail } from '@shop/contracts/order/schemas';
import type {
  Shipment,
  ShipBody,
  ShipmentTracking,
  ShipmentUpdateBody,
} from '@shop/contracts/order/order.fulfil.schemas';
import type { DbOrTx, Tx } from '@shop/db';
import { requireAdminId, requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, generateOrderNo, toId, toIdOrNull } from '../kernel/ids';
import { recordEffect } from '../effects';
import { orderFulfilConfig } from './order.fulfil.config';
import * as fulfilRepo from './order.fulfil.repo';
import * as rules from './order.fulfil.rules';
import { resolveLogisticsPort, resolveWechatReceiptVerifier } from './order.fulfil.ports';
import * as repo from './order.repo';
import { detailOf } from './order.query.service';
import { requireOrderRef } from './order.ref';
import {
  getOrderKindHandler,
  onOrderCompleted,
  onShipmentDispatched,
  onShipmentUpdated,
} from './ports';
import { orderStateMachine } from './order.state-machine';

/**
 * Shipping and receipt.
 *
 * Dispatch, partial dispatch and receipt live in this one file, with no
 * split-order machinery. The design is worth stating plainly:
 *
 *  1. **A dispatch is a `shipments` row plus `shipment_items` plus N
 *     conditional bumps of `order_items.shipped_quantity`.** There is no
 *     child order, no re-prorated money, no `surplus_num`.
 *  2. **The bound lives in the UPDATE.** `shipped + q <= quantity - refunded`
 *     is in the WHERE of every bump, so a refund approved mid-form and a second
 *     operator pressing 发货 are both handled by the database saying "zero
 *     rows", where a read-then-write would ship the same units twice.
 *  3. **Only the last outstanding unit moves the order.** The roll-up is
 *     computed from the *locked* line states and then applied as
 *     `paid -> shipped` through `OrderStateMachine.transition`, so two
 *     dispatches finishing the order at the same instant produce one
 *     transition and one set of effects.
 *  4. **Receipt has three doors and one lock.** The buyer's button, the
 *     operator's button and the auto-receive job all run the same conditional
 *     `shipped -> received`; whoever loses the race simply finds it done.
 */

// ---------------------------------------------------------------------------
// wire mapping
// ---------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export interface ShipmentContext {
  items: Map<number, repo.OrderItemRow>;
  companies: Map<number, string>;
}

export async function shipmentContextFor(
  ctx: Ctx,
  orderIds: readonly number[],
  shipments: readonly fulfilRepo.ShipmentRow[],
): Promise<ShipmentContext> {
  const items = await repo.listItems(ctx.db, orderIds);
  const companyIds = [
    ...new Set(
      shipments
        .map((shipment) => shipment.expressCompanyId)
        .filter((value): value is number => value !== null),
    ),
  ];
  const companies = new Map<number, string>();
  if (companyIds.length > 0) {
    for (const company of await fulfilRepo.listExpressCompanies(ctx.db)) {
      companies.set(company.id, company.name);
    }
  }
  return { items: new Map(items.map((item) => [item.id, item])), companies };
}

export function toWireShipment(
  row: fulfilRepo.ShipmentRow,
  lines: readonly fulfilRepo.ShipmentItemRow[],
  context: ShipmentContext,
): Shipment {
  return {
    id: toId(row.id),
    orderId: toId(row.orderId),
    shipmentNo: row.shipmentNo,
    deliveryMode: row.deliveryMode,
    status: row.status,
    expressCompanyId: toIdOrNull(row.expressCompanyId),
    expressCompanyName:
      row.expressCompanyId === null ? null : (context.companies.get(row.expressCompanyId) ?? null),
    trackingNo: row.trackingNo,
    courierName: row.courierName,
    courierPhone: row.courierPhone,
    virtualContent: row.virtualContent,
    remark: row.remark,
    dispatchedAt: row.dispatchedAt.toISOString(),
    deliveredAt: iso(row.deliveredAt),
    cancelledAt: iso(row.cancelledAt),
    lines: lines
      .filter((line) => line.shipmentId === row.id)
      .map((line) => {
        const item = context.items.get(line.orderItemId);
        return {
          orderItemId: toId(line.orderItemId),
          itemKey: item?.itemKey ?? '',
          productName: item?.snapshot.productName ?? '',
          productImageUrl: item?.snapshot.productImageUrl ?? '',
          specText: item?.snapshot.specText ?? '',
          quantity: line.quantity,
        };
      }),
  };
}

/** Every shipment of one order, as the contract shapes them. */
export async function shipmentsOfOrder(ctx: Ctx, orderId: number): Promise<Shipment[]> {
  const rows = await fulfilRepo.listShipments(ctx.db, [orderId]);
  const lines = await fulfilRepo.listShipmentItems(
    ctx.db,
    rows.map((row) => row.id),
  );
  const context = await shipmentContextFor(ctx, [orderId], rows);
  return rows.map((row) => toWireShipment(row, lines, context));
}

async function readShipment(ctx: Ctx, shipmentId: number): Promise<Shipment> {
  const row = await fulfilRepo.findShipment(ctx.db, shipmentId);
  if (!row) throw new DomainError('ORDER_SHIPMENT_NOT_FOUND');
  const lines = await fulfilRepo.listShipmentItems(ctx.db, [row.id]);
  const context = await shipmentContextFor(ctx, [row.orderId], [row]);
  return toWireShipment(row, lines, context);
}

/**
 * What another domain needs to report one shipment to somebody else — today,
 * WeChat's 小程序发货信息管理 (the payment domain's upload effect).
 *
 * `earlierShipmentIds` are this order's other *live* shipments that were
 * dispatched before this one: a split delivery is reported in dispatch order.
 */
export interface ShipmentReportFacts {
  shipment: Shipment;
  order: {
    id: number;
    orderNo: string;
    userId: number;
    status: repo.OrderRow['status'];
    receiverPhone: string;
  };
  expressCompany: { name: string; code: string; wechatDeliveryId: string | null } | null;
  earlierShipmentIds: number[];
}

/**
 * The signed-in shopper's own order, by id or order number — or
 * `ORDER_NOT_FOUND`, the same answer for a stranger's order as for no order
 * (AUTH-005). For another domain's storefront route about an order.
 */
export async function requireOwnOrder(
  ctx: Ctx,
  ref: string,
): Promise<{ id: number; userId: number; status: repo.OrderRow['status'] }> {
  const { orderId, userId } = await requireOrderRef(ctx, ref);
  const owned = await repo.findOrderForUser(ctx.db, { id: orderId, userId });
  if (!owned) throw new DomainError('ORDER_NOT_FOUND');
  return { id: owned.id, userId: owned.userId, status: owned.status };
}

export async function shipmentReportFacts(
  ctx: Ctx,
  shipmentId: number,
): Promise<ShipmentReportFacts | null> {
  const row = await fulfilRepo.findShipment(ctx.db, shipmentId);
  if (!row) return null;
  const order = await repo.findOrder(ctx.db, row.orderId);
  if (!order) return null;
  const company =
    row.expressCompanyId === null
      ? null
      : await fulfilRepo.findExpressCompanyEvenDisabled(ctx.db, row.expressCompanyId);
  const siblings = await fulfilRepo.listShipments(ctx.db, [row.orderId]);
  return {
    shipment: await readShipment(ctx, shipmentId),
    order: {
      id: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      status: order.status,
      receiverPhone: order.receiverPhone,
    },
    expressCompany: company
      ? { name: company.name, code: company.code, wechatDeliveryId: company.wechatDeliveryId }
      : null,
    earlierShipmentIds: siblings
      .filter((other) => other.id < row.id && other.status !== 'cancelled')
      .map((other) => other.id),
  };
}

// ---------------------------------------------------------------------------
// shipping
// ---------------------------------------------------------------------------

/**
 * RISK-D-011: whether the order's kind lets it ship yet — a 拼团 order only once its team
 * succeeded. Manual 发货 and auto-delivery both ask.
 */
export async function readyToShip(
  db: DbOrTx,
  order: { id: number; kind: string },
): Promise<boolean> {
  const handler = getOrderKindHandler(order.kind);
  return handler?.readyToShip ? handler.readyToShip(db, order.id) : true;
}

export interface ShipInput {
  orderId: number;
  body: ShipBody;
  /** Recorded on the shipment and the timeline. Exactly one of the two is set. */
  operatorAdminId?: number;
  operatorUserId?: number;
}

/**
 * The one dispatch. The admin console and any future bulk-import screen all
 * come through here.
 */
export async function shipOrder(ctx: Ctx, input: ShipInput): Promise<Shipment> {
  const now = ctx.clock.now();
  const { autoReceiveDays } = await ctx.config.get(orderFulfilConfig);

  const outcome = await ctx.withTx(
    async (tx): Promise<{ shipmentId: number; fulfilled: boolean }> => {
      const order = await repo.lockOrder(tx, input.orderId);
      if (!order || order.deletedAt !== null) throw new DomainError('ORDER_NOT_FOUND');
      // Only a paid, not-yet-fully-shipped order can be dispatched. `shipped`,
      // `received`, `completed`, `refunded`, `cancelled` and `pending_payment`
      // all land on the same refusal, because the operator can do the same thing
      // about each of them: nothing.
      if (order.status !== 'paid') {
        throw new DomainError('ORDER_NOT_SHIPPABLE', { details: { status: order.status } });
      }
      // RISK-D-011: a 拼团 order waits for its team.
      if (!(await readyToShip(tx, order))) throw new DomainError('ORDER_GROUPBUY_NOT_READY');

      const lines = await fulfilRepo.lockLineProgress(tx, order.id);
      const plan = rules.planShipment(
        lines,
        input.body.lines.map((line) => ({
          orderItemId: fromId(line.orderItemId),
          quantity: line.quantity,
        })),
      );
      switch (plan.kind) {
        case 'nothing-outstanding':
          throw new DomainError('ORDER_NOT_SHIPPABLE', {
            details: { reason: 'nothing outstanding' },
          });
        case 'auto-delivered-only':
          throw new DomainError('ORDER_VIRTUAL_AUTO_DELIVERED');
        case 'unknown-lines':
          throw new DomainError('ORDER_SHIP_LINE_INVALID', {
            details: { orderItemIds: plan.orderItemIds.map(toId) },
          });
        case 'over-ship':
          throw new DomainError('ORDER_SHIP_QUANTITY_EXCEEDED', {
            details: {
              orderItemId: toId(plan.orderItemId),
              requested: plan.requested,
              remaining: plan.remaining,
            },
          });
        default:
          break;
      }

      const expressCompanyId =
        input.body.expressCompanyId === undefined ? null : fromId(input.body.expressCompanyId);
      if (input.body.deliveryMode === 'express') {
        if (expressCompanyId === null) throw new DomainError('ORDER_EXPRESS_COMPANY_NOT_FOUND');
        const company = await fulfilRepo.findExpressCompany(tx, expressCompanyId);
        if (!company) throw new DomainError('ORDER_EXPRESS_COMPANY_NOT_FOUND');
      }

      const shipment = await fulfilRepo.insertShipment(tx, {
        orderId: order.id,
        shipmentNo: generateOrderNo(ctx.clock, { prefix: 'SH' }),
        deliveryMode: input.body.deliveryMode,
        status: 'dispatched',
        expressCompanyId,
        trackingNo: input.body.trackingNo ?? null,
        courierName: input.body.courierName ?? null,
        courierPhone: input.body.courierPhone ?? null,
        virtualContent: input.body.virtualContent ?? null,
        remark: input.body.remark ?? null,
        operatorAdminId: input.operatorAdminId ?? null,
        dispatchedAt: now,
      });

      await fulfilRepo.insertShipmentItems(
        tx,
        plan.lines.map((line) => ({
          shipmentId: shipment.id,
          orderItemId: line.orderItemId,
          quantity: line.quantity,
        })),
      );

      // Each bump carries the whole bound. A zero here means a refund or another
      // dispatch got in between the lock and the write on that specific line;
      // throwing rolls the shipment row back with it.
      for (const line of plan.lines) {
        const bumped = await fulfilRepo.bumpShippedQuantity(tx, {
          orderItemId: line.orderItemId,
          orderId: order.id,
          quantity: line.quantity,
        });
        if (!bumped.won) {
          throw new DomainError('ORDER_SHIP_QUANTITY_EXCEEDED', {
            details: { orderItemId: toId(line.orderItemId), requested: line.quantity },
          });
        }
      }

      const after = rules.applyPlan(lines, plan.lines);
      const rollUp = rules.rollUpFulfillment(after);

      if (rollUp === 'fulfilled') {
        // The CHECK `orders_fulfillment_matches_status` wants the two to agree,
        // so the column moves first and the status follows in the same statement
        // pair, both conditional.
        await fulfilRepo.setFulfillmentStatus(tx, {
          orderId: order.id,
          from: ['unfulfilled', 'partially_fulfilled'],
          to: 'fulfilled',
        });
        const autoReceiveAt = new Date(now.getTime() + autoReceiveDays * 86_400_000);
        const moved = await orderStateMachine.transition(tx, order.id, ['paid'], 'shipped', {
          at: now,
          autoReceiveAt,
        });
        if (!moved.won) throw new DomainError('ORDER_NOT_SHIPPABLE');
      } else {
        await fulfilRepo.setFulfillmentStatus(tx, {
          orderId: order.id,
          from: ['unfulfilled'],
          to: 'partially_fulfilled',
        });
      }

      await repo.insertStatusLog(tx, {
        orderId: order.id,
        changeType: input.body.deliveryMode === 'virtual' ? 'virtual_delivered' : 'shipped',
        fromStatus: 'paid',
        toStatus: rollUp === 'fulfilled' ? 'shipped' : 'paid',
        message: shipmentMessage(input.body),
        operatorKind: input.operatorAdminId !== undefined ? 'admin' : 'user',
        ...(input.operatorAdminId === undefined ? {} : { operatorAdminId: input.operatorAdminId }),
        ...(input.operatorUserId === undefined ? {} : { operatorUserId: input.operatorUserId }),
      });

      await recordEffect(tx, ctx, {
        scope: 'shipment',
        scopeId: String(shipment.id),
        eventType: 'shipment.dispatched',
        payload: { orderId: order.id, userId: order.userId, shipmentId: shipment.id },
      });

      await onShipmentDispatched.dispatch(tx, ctx, {
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        at: now,
        shipmentId: shipment.id,
        deliveryMode: input.body.deliveryMode,
        allDelivered: rollUp === 'fulfilled',
        otherShipments: (await fulfilRepo.listShipments(tx, [order.id]))
          .filter((other) => other.id !== shipment.id)
          .map((other) => ({ id: other.id, cancelled: other.status === 'cancelled' })),
      });

      return { shipmentId: shipment.id, fulfilled: rollUp === 'fulfilled' };
    },
  );

  if (outcome.fulfilled) {
    // The delayed job does the real auto-receive; `order.sweepAutoReceive` is
    // only there for the day the queue loses it. `dedupeKey` means a second
    // dispatch that also finishes the order cannot queue a second one.
    await scheduleAutoReceive(ctx, input.orderId, autoReceiveDays);
  }
  ctx.logger.info({ orderId: input.orderId, shipmentId: outcome.shipmentId }, 'order shipped');
  return readShipment(ctx, outcome.shipmentId);
}

/** Shared with the virtual-delivery handler, which also finishes orders. */
export async function scheduleAutoReceive(
  ctx: Ctx,
  orderId: number,
  autoReceiveDays: number,
): Promise<void> {
  await ctx.queue.enqueue(
    'order.autoReceive',
    { orderId: toId(orderId) },
    { delay: autoReceiveDays * 86_400_000, dedupeKey: autoReceiveKey(orderId) },
  );
}

function shipmentMessage(body: ShipBody): string {
  if (body.deliveryMode === 'express') return `快递发货 ${body.trackingNo ?? ''}`.trim();
  if (body.deliveryMode === 'merchant_delivery') {
    return `商家配送 ${body.courierName ?? ''} ${body.courierPhone ?? ''}`.trim();
  }
  return '虚拟发货';
}

/**
 * 修改发货信息.
 *
 * Only the transport details. Which lines went out is settled by
 * `shipment_items` and `shipped_quantity`, and changing *that* means cancelling
 * the shipment and shipping again — otherwise the two would have to be kept in
 * step by hand, and a hand-kept pair loses units.
 */
export async function updateShipment(
  ctx: Ctx,
  params: { id: string },
  body: ShipmentUpdateBody,
): Promise<Shipment> {
  const shipmentId = fromId(params.id);
  const adminId = ctx.actor.kind === 'admin' ? requireAdminId(ctx) : undefined;

  await ctx.withTx(async (tx) => {
    const shipment = await fulfilRepo.findShipment(tx, shipmentId);
    if (!shipment) throw new DomainError('ORDER_SHIPMENT_NOT_FOUND');

    const set: Record<string, unknown> = {};
    if (body.expressCompanyId !== undefined) {
      const companyId = fromId(body.expressCompanyId);
      const company = await fulfilRepo.findExpressCompany(tx, companyId);
      if (!company) throw new DomainError('ORDER_EXPRESS_COMPANY_NOT_FOUND');
      set.expressCompanyId = companyId;
    }
    if (body.trackingNo !== undefined) set.trackingNo = body.trackingNo;
    if (body.courierName !== undefined) set.courierName = body.courierName;
    if (body.courierPhone !== undefined) set.courierPhone = body.courierPhone;
    if (body.remark !== undefined) set.remark = body.remark;
    if (Object.keys(set).length === 0) return;

    const updated = await fulfilRepo.updateShipmentInfo(tx, { shipmentId, set });
    if (!updated.won) throw new DomainError('ORDER_SHIPMENT_NOT_EDITABLE');

    // A plain read: `cancelShipment` locks the order *before* the shipment, so
    // taking the order lock here, after the shipment row, could deadlock with it.
    const order = await repo.findOrder(tx, shipment.orderId);
    if (order) {
      await onShipmentUpdated.dispatch(tx, ctx, {
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        at: ctx.clock.now(),
        shipmentId,
      });
    }

    await repo.insertStatusLog(tx, {
      orderId: shipment.orderId,
      changeType: 'shipment_updated',
      message: `修改发货单 ${shipment.shipmentNo}`,
      operatorKind: adminId === undefined ? 'user' : 'admin',
      ...(adminId === undefined ? {} : { operatorAdminId: adminId }),
    });
  });

  return readShipment(ctx, shipmentId);
}

/**
 * 撤销发货.
 *
 * Allowed only while the order is still `paid` — i.e. this shipment did not
 * finish it. Once every line is out the order is `shipped`, and
 * `ORDER_TRANSITIONS` has no `shipped -> paid` edge: walking the
 * customer-facing status backwards is not something this system does, because a
 * buyer who was told 已发货 and then sees 待发货 will open a ticket faster than
 * the operator can fix the waybill. The correction for a fully shipped order is
 * 修改发货信息, which is why that route exists.
 */
export async function cancelShipment(
  ctx: Ctx,
  params: { id: string },
  body: { reason?: string | undefined },
): Promise<Shipment> {
  const shipmentId = fromId(params.id);
  const now = ctx.clock.now();
  const adminId = ctx.actor.kind === 'admin' ? requireAdminId(ctx) : undefined;

  await ctx.withTx(async (tx) => {
    const shipment = await fulfilRepo.findShipment(tx, shipmentId);
    if (!shipment) throw new DomainError('ORDER_SHIPMENT_NOT_FOUND');

    const order = await repo.lockOrder(tx, shipment.orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND');
    if (order.status !== 'paid') {
      throw new DomainError('ORDER_SHIPMENT_NOT_EDITABLE', {
        details: { reason: 'order already left paid', status: order.status },
      });
    }

    const cancelled = await fulfilRepo.cancelShipmentRow(tx, {
      shipmentId,
      at: now,
      remark: body.reason ?? null,
    });
    if (!cancelled.won) throw new DomainError('ORDER_SHIPMENT_NOT_EDITABLE');

    const lines = await fulfilRepo.listShipmentItems(tx, [shipmentId]);
    for (const line of lines) {
      const released = await fulfilRepo.releaseShippedQuantity(tx, {
        orderItemId: line.orderItemId,
        quantity: line.quantity,
      });
      // The column cannot go negative and the shipment we just cancelled is the
      // only thing that put those units there, so a loss here is a real defect.
      if (!released.won) throw new DomainError('ORDER_SHIPMENT_NOT_EDITABLE');
    }

    const after = await fulfilRepo.lockLineProgress(tx, order.id);
    const rollUp = rules.rollUpFulfillment(after);
    await fulfilRepo.setFulfillmentStatus(tx, {
      orderId: order.id,
      from: ['unfulfilled', 'partially_fulfilled', 'fulfilled'],
      to: rollUp,
    });

    await repo.insertStatusLog(tx, {
      orderId: order.id,
      changeType: 'shipment_cancelled',
      message: body.reason?.trim() || `撤销发货单 ${shipment.shipmentNo}`,
      operatorKind: adminId === undefined ? 'user' : 'admin',
      ...(adminId === undefined ? {} : { operatorAdminId: adminId }),
    });
  });

  return readShipment(ctx, shipmentId);
}

// ---------------------------------------------------------------------------
// tracking
// ---------------------------------------------------------------------------

export async function trackShipment(
  ctx: Ctx,
  params: { id: string },
  options: { userId?: number } = {},
): Promise<ShipmentTracking> {
  const shipmentId = fromId(params.id);
  const row = await fulfilRepo.findShipment(ctx.db, shipmentId);
  if (!row) throw new DomainError('ORDER_SHIPMENT_NOT_FOUND');

  // A stranger asking about somebody else's parcel gets the same answer as
  // somebody asking about a shipment that does not exist (AUTH-005).
  const owner =
    options.userId === undefined
      ? await repo.findOrder(ctx.db, row.orderId)
      : await repo.findOrderForUser(ctx.db, { id: row.orderId, userId: options.userId });
  if (options.userId !== undefined && !owner) throw new DomainError('ORDER_SHIPMENT_NOT_FOUND');

  const company =
    row.expressCompanyId === null
      ? null
      : await fulfilRepo.findExpressCompany(ctx.db, row.expressCompanyId);
  const port = resolveLogisticsPort();
  const base = {
    shipmentId: toId(row.id),
    shipmentNo: row.shipmentNo,
    expressCompanyName: company?.name ?? null,
    trackingNo: row.trackingNo,
    queriedAt: ctx.clock.now().toISOString(),
  };

  if (!port || !company || row.trackingNo === null) {
    return { ...base, available: false, state: 'unknown' as const, traces: [] };
  }

  try {
    const result = await port.track(ctx, {
      companyCode: company.code,
      trackingNo: row.trackingNo,
      // 顺丰 answers nothing without the receiver's phone tail.
      ...(owner ? { phone: owner.receiverPhone } : {}),
    });
    return {
      ...base,
      available: true,
      state: result.state,
      traces: result.traces.map((trace) => ({
        at: trace.at.toISOString(),
        context: trace.context,
      })),
    };
  } catch (error) {
    // A courier API being down is not an error the operator can act on, and it
    // must not take the order detail page down with it.
    ctx.logger.warn({ err: error, shipmentId }, 'logistics lookup failed');
    return { ...base, available: false, state: 'unknown' as const, traces: [] };
  }
}

// ---------------------------------------------------------------------------
// receipt and completion
// ---------------------------------------------------------------------------

export interface ReceiptInput {
  orderId: number;
  /**
   * `wechat`: WeChat's 发货信息管理 told us (the `trade_manage_order_settlement`
   * push) that the buyer confirmed receipt, by hand or by WeChat's own timeout.
   */
  by: 'user' | 'admin' | 'auto' | 'wechat';
  /** Replaces the timeline message; the default names who confirmed. */
  message?: string;
  operatorAdminId?: number;
  operatorUserId?: number;
  /** `true` turns a lost race into an error. The job leaves it false. */
  strict?: boolean;
}

export interface ReceiptOutcome {
  received: boolean;
}

/**
 * `shipped -> received`, whoever asked.
 *
 * One conditional transition decides it; the shipments are marked delivered and
 * the auto-receive deadline is cleared by the winner only, so the job firing at
 * the same moment the buyer taps 确认收货 leaves exactly one timeline entry.
 */
export async function receiveOrder(ctx: Ctx, input: ReceiptInput): Promise<ReceiptOutcome> {
  const now = ctx.clock.now();
  const strict = input.strict ?? false;

  const outcome = await ctx.withTx(async (tx): Promise<ReceiptOutcome> => {
    const order = await repo.lockOrder(tx, input.orderId);
    if (!order || order.deletedAt !== null) throw new DomainError('ORDER_NOT_FOUND');
    if (order.status !== 'shipped') {
      if (strict)
        throw new DomainError('ORDER_NOT_RECEIVABLE', { details: { status: order.status } });
      return { received: false };
    }

    const moved = await orderStateMachine.transition(tx, order.id, ['shipped'], 'received', {
      at: now,
      autoReceiveAt: null,
    });
    if (!moved.won) {
      if (strict) throw new DomainError('ORDER_NOT_RECEIVABLE');
      return { received: false };
    }

    await fulfilRepo.markShipmentsDelivered(tx, { orderId: order.id, at: now });

    await repo.insertStatusLog(tx, {
      orderId: order.id,
      changeType: input.by === 'auto' ? 'auto_received' : 'received',
      fromStatus: 'shipped',
      toStatus: 'received',
      message:
        input.message ??
        (input.by === 'auto'
          ? '超时未确认，系统自动确认收货'
          : input.by === 'admin'
            ? '后台确认收货'
            : input.by === 'wechat'
              ? '微信已确认收货'
              : '用户确认收货'),
      operatorKind: input.by === 'auto' ? 'system' : input.by === 'wechat' ? 'gateway' : input.by,
      ...(input.operatorAdminId === undefined ? {} : { operatorAdminId: input.operatorAdminId }),
      ...(input.operatorUserId === undefined ? {} : { operatorUserId: input.operatorUserId }),
    });

    await recordEffect(tx, ctx, {
      scope: 'order',
      scopeId: String(order.id),
      eventType: 'order.received',
      payload: { orderId: order.id, userId: order.userId },
    });

    return { received: true };
  });

  if (outcome.received) {
    const { reviewWindowDays } = await ctx.config.get(orderFulfilConfig);
    await ctx.queue.cancel(autoReceiveKey(input.orderId));
    await ctx.queue.enqueue(
      'order.complete',
      { orderId: toId(input.orderId) },
      {
        delay: reviewWindowDays * 86_400_000,
        dedupeKey: completionKey(input.orderId),
      },
    );
  }
  return outcome;
}

export const autoReceiveKey = (orderId: number): string => `order-auto-receive:${orderId}`;
export const completionKey = (orderId: number): string => `order-complete:${orderId}`;

/**
 * `POST /api/v1/orders/:id/receipt`.
 *
 * With `{ via: 'wechat-component' }` the buyer confirmed in WeChat's own
 * 确认收货 component, and the order moves only once WeChat's `get_order` agrees
 * (C07). WeChat may have told us first — the settlement push — so a lost race
 * here is not an error: the buyer sees the order as it now is.
 */
export async function confirmReceipt(
  ctx: Ctx,
  params: { id: string },
  body: { via?: 'wechat-component' | undefined } = {},
): Promise<OrderDetail> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);
  const owned = await repo.findOrderForUser(ctx.db, { id: orderId, userId });
  if (!owned) throw new DomainError('ORDER_NOT_FOUND');

  if (body.via === 'wechat-component') {
    const verifier = resolveWechatReceiptVerifier();
    const verdict = verifier ? await verifier.verify(ctx, { orderId }) : 'unavailable';
    if (verdict !== 'confirmed') {
      throw new DomainError('ORDER_WECHAT_RECEIPT_UNCONFIRMED', { details: { verdict } });
    }
    await receiveOrder(ctx, {
      orderId,
      by: 'user',
      operatorUserId: userId,
      message: '用户在微信确认收货',
    });
    return detailOf(ctx, { orderId, userId });
  }

  await receiveOrder(ctx, { orderId, by: 'user', operatorUserId: userId, strict: true });
  return detailOf(ctx, { orderId, userId });
}

/** The delayed job and the sweep. Never throws for a lost race. */
export async function autoReceive(ctx: Ctx, input: { orderId: number }): Promise<ReceiptOutcome> {
  return receiveOrder(ctx, { orderId: input.orderId, by: 'auto' });
}

/**
 * The backstop. The per-order delayed job does the real work; this exists
 * because a queue can lose a job and a shipped order must not sit unconfirmed
 * forever. Nothing depends on it for correctness — both paths run the same
 * conditional transition, so a double delivery is a no-op.
 */
export async function sweepAutoReceive(
  ctx: Ctx,
  options: { limit?: number } = {},
): Promise<{ scanned: number; received: number }> {
  const { autoReceiveSweepLimit } = await ctx.config.get(orderFulfilConfig);
  const ids = await fulfilRepo.listAutoReceiveDue(ctx.db, {
    now: ctx.clock.now(),
    limit: options.limit ?? autoReceiveSweepLimit,
  });
  let received = 0;
  for (const orderId of ids) {
    try {
      if ((await autoReceive(ctx, { orderId })).received) received += 1;
    } catch (error) {
      ctx.logger.warn({ err: error, orderId }, 'auto-receive sweep: failed');
    }
  }
  return { scanned: ids.length, received };
}

/**
 * `received -> completed`, once the review window has run out.
 *
 * The window is the only thing between the two states; leaving a review does
 * not complete an order early, because 已完成 is what makes an order eligible
 * for nothing in particular and rushing it gains no one anything.
 */
export async function completeOrder(
  ctx: Ctx,
  input: { orderId: number },
): Promise<{ completed: boolean }> {
  const now = ctx.clock.now();
  const { reviewWindowDays } = await ctx.config.get(orderFulfilConfig);

  return ctx.withTx(async (tx) => {
    const order = await repo.lockOrder(tx, input.orderId);
    if (!order) return { completed: false };
    if (order.status !== 'received' || order.receivedAt === null) return { completed: false };
    const due = new Date(order.receivedAt.getTime() + reviewWindowDays * 86_400_000);
    if (due > now) return { completed: false };

    const moved = await orderStateMachine.transition(tx, order.id, ['received'], 'completed', {
      at: now,
    });
    if (!moved.won) return { completed: false };

    await repo.insertStatusLog(tx, {
      orderId: order.id,
      changeType: 'completed',
      fromStatus: 'received',
      toStatus: 'completed',
      message: '评价期结束，订单完成',
      operatorKind: 'system',
    });

    await completedHooks(tx, ctx, order);
    return { completed: true };
  });
}

async function completedHooks(tx: Tx, ctx: Ctx, order: repo.OrderRow): Promise<void> {
  await onOrderCompleted.dispatch(tx, ctx, {
    orderId: order.id,
    orderNo: order.orderNo,
    userId: order.userId,
    at: ctx.clock.now(),
    completedBy: 'auto',
  });
  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(order.id),
    eventType: 'order.completed',
    payload: { orderId: order.id, userId: order.userId },
  });
}

export async function sweepCompletions(
  ctx: Ctx,
  options: { limit?: number } = {},
): Promise<{ scanned: number; completed: number }> {
  const { reviewWindowDays, completionSweepLimit } = await ctx.config.get(orderFulfilConfig);
  const ids = await fulfilRepo.listCompletionDue(ctx.db, {
    receivedBefore: new Date(ctx.clock.now().getTime() - reviewWindowDays * 86_400_000),
    limit: options.limit ?? completionSweepLimit,
  });
  let completed = 0;
  for (const orderId of ids) {
    try {
      if ((await completeOrder(ctx, { orderId })).completed) completed += 1;
    } catch (error) {
      ctx.logger.warn({ err: error, orderId }, 'completion sweep: failed');
    }
  }
  return { scanned: ids.length, completed };
}

// ---------------------------------------------------------------------------
// storefront reads
// ---------------------------------------------------------------------------

export async function myShipments(
  ctx: Ctx,
  params: { id: string },
): Promise<{ items: Shipment[] }> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);
  const owned = await repo.findOrderForUser(ctx.db, { id: orderId, userId });
  if (!owned) throw new DomainError('ORDER_NOT_FOUND');
  return { items: await shipmentsOfOrder(ctx, orderId) };
}

export async function myShipmentTracking(
  ctx: Ctx,
  params: { id: string },
): Promise<ShipmentTracking> {
  return trackShipment(ctx, params, { userId: requireUserId(ctx) });
}

// ---------------------------------------------------------------------------
// route-facing wrappers
// ---------------------------------------------------------------------------

/** `POST /admin-api/orders/:id/shipments`. */
export async function adminShip(
  ctx: Ctx,
  params: { id: string },
  body: ShipBody,
): Promise<Shipment> {
  return shipOrder(ctx, {
    orderId: fromId(params.id),
    body,
    operatorAdminId: requireAdminId(ctx),
  });
}

/** `GET /admin-api/shipments/:id/tracking` — no owner check; the operator sees every parcel. */
export async function adminTrackShipment(
  ctx: Ctx,
  params: { id: string },
): Promise<ShipmentTracking> {
  return trackShipment(ctx, params);
}

// The 快递公司 picker belongs to the `shipping` domain:
// `expressCompanies.pickerList` in `core/src/shipping/`.
// `fulfilRepo.listExpressCompanies` / `findExpressCompany` stay here — 发货
// still has to validate the carrier it was handed.
