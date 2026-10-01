import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import { refunds } from '@shop/db/schema/refund';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import { createTestCtx, flushTestRedis, forkTestCtx, type TestCtx } from '@shop/testing';
import { resetEffectHandlers } from '../effects';
import { anonymousActor, type Actor, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { registerNotificationDomain } from '../notification';
import { installFulfilmentHooks } from '../order';
import { registerStockPort, resetOrderPorts } from '../order/ports';
import * as admin from './refund.admin';
import { refundConfig } from './refund.config';
import * as service from './refund.service';

/**
 * AUTH-005 — a stranger cannot read or act on somebody else's after-sale.
 *
 * `refund.service.ts` guards every shopper-facing read and write with one
 * clause repeated four times:
 *
 * ```ts
 * if (!row || row.userId !== userId) throw new DomainError('REFUND_NOT_FOUND');
 * ```
 *
 * `!row` and "somebody else's row" deliberately answer the **same** error, so
 * the storefront cannot be used to probe which refund ids exist. That identity
 * is the property, and it is what this file asserts: not "it throws", but *the
 * same code, the same message, the same status and the same details* as a
 * refund id that never existed. An assertion that only checked "it throws"
 * would pass a change to a 403, which is the information leak AUTH-005 exists
 * to prevent.
 *
 * The second half of the ledger row is the admin side: the admin refund route
 * refuses an unauthenticated caller **without completing the after-sale** —
 * the refusal happens before any row moves, not after.
 *
 * `executeRefund` is deliberately not here: the dispatcher calls it with no
 * shopper in hand, which is why it checks `!row` alone.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  resetEffectHandlers();
  resetOrderPorts();
  installFulfilmentHooks();
  registerNotificationDomain();
  registerStockPort({
    async reserve() {
      return [];
    },
    async commit() {},
    async release() {},
  });
});

afterEach(() => {
  resetEffectHandlers();
  resetOrderPorts();
  installFulfilmentHooks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const superAdmin = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });
/** An admin account with a real id but not one atom granted. */
const plainAdmin = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: false });

const as = (actor: Actor): Ctx => forkTestCtx(harness, { actor });

const snapshot = (): OrderItemSnapshot => ({
  productName: '隔离测试商品',
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: 'SKU-ISO',
  specText: '默认',
  specValues: {},
});

interface Scene {
  /** The shopper who placed the order and applied for the refund. */
  ownerId: number;
  /** A second shopper with an account of their own and nothing to do with it. */
  strangerId: number;
  adminId: number;
  orderId: number;
  orderItemId: number;
  refundId: number;
}

let sequence = 0;

/**
 * Two shoppers, one paid order, one `applied` refund.
 *
 * The order is marked paid directly rather than through the gateway: this file
 * is about who may look at the row, and a fake WeChat adds a minute to every
 * run without changing the answer.
 */
async function scene(): Promise<Scene> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;

  const [owner] = await db
    .insert(users)
    .values({ account: `iso-owner-${n}` })
    .returning({ id: users.id });
  const [stranger] = await db
    .insert(users)
    .values({ account: `iso-stranger-${n}` })
    .returning({ id: users.id });
  const [operator] = await db
    .insert(admins)
    .values({
      account: `iso-admin-${n}`,
      passwordHash: 'x'.repeat(60),
      name: `运营${n}`,
      isSuper: true,
    })
    .returning({ id: admins.id });
  const [product] = await db
    .insert(products)
    .values({
      name: '隔离测试商品',
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: '50.00',
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `ISO${n}`, price: '50.00', stock: 100 })
    .returning({ id: productSkus.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `IO${String(n).padStart(10, '0')}`,
      userId: owner!.id,
      platform: 'wechat_mini',
      status: 'paid',
      totalQuantity: 2,
      itemsAmount: '100.00',
      payableAmount: '100.00',
      paidAmount: '100.00',
      paidAt: harness.clock.now(),
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      productId: product!.id,
      skuId: sku!.id,
      itemKey: 'L1',
      quantity: 2,
      unitPrice: '50.00',
      totalAmount: '100.00',
      snapshot: snapshot(),
    })
    .returning({ id: orderItems.id });

  // A return is only approved with somewhere to send the goods.
  await harness.ctx.config.set(refundConfig, {
    returnName: '售后部',
    returnPhone: '13800000000',
    returnAddress: '浙江省杭州市西湖区文一西路 1 号',
  });

  const applied = await service.apply(as(userActor(owner!.id)), {
    orderId: String(order!.id),
    kind: 'return_and_refund',
    lines: [{ orderItemId: String(item!.id), quantity: 1 }],
    reason: '不想要了',
    images: [],
    includeFreight: false,
  });

  return {
    ownerId: owner!.id,
    strangerId: stranger!.id,
    adminId: operator!.id,
    orderId: order!.id,
    orderItemId: item!.id,
    refundId: Number(applied.id),
  };
}

/**
 * An id no refund has ever had. Larger than every sequence value the table has
 * handed out, so it is "does not exist" rather than "deleted".
 */
const UNKNOWN_ID = '999000999';

/**
 * The refusal, reduced to the four things a client can see.
 *
 * `status` and `message` come from the contracts error registry, so comparing
 * them compares what actually reaches the browser — a change to a distinct
 * `REFUND_FORBIDDEN` code would change all of `code`, `status` and `message`,
 * and a change that kept the code but added `details: { ownerId }` would change
 * `details`.
 */
interface Refusal {
  code: string;
  status: number;
  message: string;
  details: unknown;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    const value = await run();
    throw new Error(`expected a refusal, got ${JSON.stringify(value)}`);
  } catch (error) {
    if (!DomainError.is(error)) throw error;
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details,
    };
  }
}

const refundRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, id))
    .then((rows) => rows[0]!);

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const refundEffects = () =>
  harness.ctx.db.select().from(effectsTable).where(eq(effectsTable.scope, 'refund'));

// ---------------------------------------------------------------------------

describe('AUTH-005 — a stranger and another shopper’s after-sale', () => {
  it('lets the owner read the after-sale detail', async () => {
    const s = await scene();
    const detail = await service.myDetail(as(userActor(s.ownerId)), { id: String(s.refundId) });

    expect(detail.id).toBe(String(s.refundId));
    expect(detail.status).toBe('applied');
    expect(detail.items).toHaveLength(1);
  });

  it('answers a stranger’s read with exactly what an unknown id answers', async () => {
    const s = await scene();
    const stranger = as(userActor(s.strangerId));

    const onSomebodyElses = await refusalOf(() =>
      service.myDetail(stranger, { id: String(s.refundId) }),
    );
    const onNothingAtAll = await refusalOf(() => service.myDetail(stranger, { id: UNKNOWN_ID }));

    // Field by field, not "an error": a 403 here would tell the caller that the
    // id exists, which is the whole leak.
    expect(onSomebodyElses).toEqual(onNothingAtAll);
    expect(onSomebodyElses).toEqual({
      code: 'REFUND_NOT_FOUND',
      status: 404,
      message: '售后单不存在',
      details: undefined,
    });
  });

  it('keeps somebody else’s after-sale out of the stranger’s own list', async () => {
    const s = await scene();
    const mine = await service.myList(as(userActor(s.strangerId)), {
      state: 'all',
      page: 1,
      pageSize: 50,
    });

    expect(mine.total).toBe(0);
    expect(mine.items).toEqual([]);

    // …and the owner does see it, so the empty list above is isolation and not
    // a broken query.
    const theirs = await service.myList(as(userActor(s.ownerId)), {
      state: 'all',
      page: 1,
      pageSize: 50,
    });
    expect(theirs.items.map((item) => item.id)).toEqual([String(s.refundId)]);
  });

  it.each([
    ['withdraw', (ctx: Ctx, id: string) => service.cancel(ctx, { id })],
    [
      'fill in the return shipment',
      (ctx: Ctx, id: string) =>
        service.submitReturnShipment(ctx, {
          id,
          expressCompanyId: '1',
          trackingNo: 'SF0000000001',
        }),
    ],
    ['hide it from the list', (ctx: Ctx, id: string) => service.hide(ctx, { id })],
  ])('refuses a stranger who tries to %s, with the same error', async (_label, act) => {
    const s = await scene();
    const stranger = as(userActor(s.strangerId));

    const onSomebodyElses = await refusalOf(() => act(stranger, String(s.refundId)));
    const onNothingAtAll = await refusalOf(() => act(stranger, UNKNOWN_ID));

    expect(onSomebodyElses).toEqual(onNothingAtAll);
    expect(onSomebodyElses.code).toBe('REFUND_NOT_FOUND');
    expect(onSomebodyElses.status).toBe(404);
  });

  it('writes nothing when a stranger tries to act on it', async () => {
    const s = await scene();
    const stranger = as(userActor(s.strangerId));
    const refundBefore = await refundRow(s.refundId);
    const orderBefore = await orderRow(s.orderId);

    await refusalOf(() => service.cancel(stranger, { id: String(s.refundId) }));
    await refusalOf(() =>
      service.submitReturnShipment(stranger, {
        id: String(s.refundId),
        expressCompanyId: '1',
        trackingNo: 'SF0000000001',
      }),
    );
    await refusalOf(() => service.hide(stranger, { id: String(s.refundId) }));

    // The whole row, not just the status: `returnTrackingNo`, `hiddenAt`,
    // `cancelledAt` and `updatedAt` are all part of "writes nothing".
    expect(await refundRow(s.refundId)).toEqual(refundBefore);
    expect(await orderRow(s.orderId)).toEqual(orderBefore);
    expect(await refundEffects()).toEqual([]);
  });

  it('refuses a stranger who applies for a refund against somebody else’s order', async () => {
    const s = await scene();
    const stranger = as(userActor(s.strangerId));
    const body = {
      orderId: String(s.orderId),
      kind: 'refund_only' as const,
      lines: [{ orderItemId: String(s.orderItemId), quantity: 1 }],
      reason: '不想要了',
      images: [],
      includeFreight: false,
    };

    const onSomebodyElses = await refusalOf(() => service.apply(stranger, body));
    const onNothingAtAll = await refusalOf(() =>
      service.apply(stranger, { ...body, orderId: UNKNOWN_ID }),
    );

    expect(onSomebodyElses).toEqual(onNothingAtAll);
    expect(onSomebodyElses.code).toBe('REFUND_ORDER_NOT_FOUND');

    // The reading half of the same screen answers identically.
    expect(
      await refusalOf(() => service.applicableItems(stranger, { orderId: String(s.orderId) })),
    ).toEqual(await refusalOf(() => service.applicableItems(stranger, { orderId: UNKNOWN_ID })));

    // Nothing was created for the stranger, and the owner still has exactly one.
    expect(
      await harness.ctx.db.select().from(refunds).where(eq(refunds.userId, s.strangerId)),
    ).toEqual([]);
  });
});

describe('AUTH-005 — the admin refund route and an unauthenticated caller', () => {
  it('refuses an unauthenticated 同意 without completing the after-sale', async () => {
    const s = await scene();
    const before = await refundRow(s.refundId);

    const refusal = await refusalOf(() =>
      admin.adminApprove(forkTestCtx(harness, { actor: anonymousActor }), {
        id: String(s.refundId),
      }),
    );

    expect(refusal.code).toBe('UNAUTHENTICATED');
    expect(refusal.status).toBe(401);

    // The point of the row: the refusal happened *before* anything moved.
    const after = await refundRow(s.refundId);
    expect(after.status).toBe('applied');
    expect(after).toEqual(before);
    expect(await refundEffects()).toEqual([]);
  });

  it.each([
    ['同意', (ctx: Ctx, id: string) => admin.adminApprove(ctx, { id })],
    ['拒绝', (ctx: Ctx, id: string) => admin.adminReject(ctx, { id, rejectReason: '不符合条件' })],
    ['查看详情', (ctx: Ctx, id: string) => admin.adminDetail(ctx, { id })],
    ['重试打款', (ctx: Ctx, id: string) => admin.adminRetry(ctx, { id })],
  ])('refuses an unauthenticated %s with 401, and a shopper with 401', async (_label, act) => {
    const s = await scene();

    expect(
      (
        await refusalOf(() =>
          act(forkTestCtx(harness, { actor: anonymousActor }), String(s.refundId)),
        )
      ).status,
    ).toBe(401);

    // A logged-in shopper is not "unauthenticated", but the admin surface is
    // still not theirs: `requirePermission` refuses a non-admin actor outright
    // rather than falling through to the service.
    const asShopper = await refusalOf(() => act(as(userActor(s.ownerId)), String(s.refundId)));
    expect(asShopper.code).toBe('FORBIDDEN');
    expect(asShopper.status).toBe(403);

    expect((await refundRow(s.refundId)).status).toBe('applied');
  });

  it('refuses an admin account that holds no refund atom, before the row moves', async () => {
    const s = await scene();
    const before = await refundRow(s.refundId);

    const refusal = await refusalOf(() =>
      admin.adminApprove(as(plainAdmin(s.adminId)), { id: String(s.refundId) }),
    );

    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.status).toBe(403);
    expect(refusal.details).toEqual({ permission: 'refund:request:review' });
    expect(await refundRow(s.refundId)).toEqual(before);
    expect(await refundEffects()).toEqual([]);
  });

  it('completes the after-sale for the admin who does hold the atom', async () => {
    const s = await scene();

    // The negative assertions above are only worth something if the same call
    // with the right actor really does move the row.
    await admin.adminApprove(as(superAdmin(s.adminId)), { id: String(s.refundId) });

    expect((await refundRow(s.refundId)).status).not.toBe('applied');
  });
});
