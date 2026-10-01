import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { orderInvoices, orderItems, orderStatusLogs, orders } from '@shop/db/schema/order';
import { admins } from '@shop/db/schema/auth';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, runConcurrently, forkTestCtx, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as order from './index';
import { installFulfilmentHooks } from './order.fulfil.effects';
import { resetFulfilmentPorts } from './order.fulfil.ports';
import { orderStateMachine } from './order.state-machine';
import { onOrderPaid, registerOrderStateMachine, resetOrderPorts } from './ports';

/**
 * 发票.
 *
 * The whole design is one partial unique index — `order_invoices_open_uq` on
 * `order_id WHERE status in ('requested','issued')` — and one CHECK,
 * `order_invoices_issued_shape`, which is why every case here needs a real
 * database. Asking "is there an open invoice?" first and then inserting would
 * be a read-then-write with a race in the gap, so the service inserts and
 * translates the conflict.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  harness.queue.reset();
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  resetFulfilmentPorts();
  registerOrderStateMachine(orderStateMachine);
  installFulfilmentHooks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

const as = (userId: number): Ctx => harness.as(userActor(userId));
const asAdmin = (adminId: number): Ctx => harness.as(adminActor(adminId));

async function makeAdmin(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account: `op-${sequence}`, passwordHash: 'x', name: `操作员${sequence}` })
    .returning({ id: admins.id });
  return row!.id;
}

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}` })
    .returning({ id: users.id });
  const userId = row!.id;
  await harness.ctx.db.insert(userAddresses).values({
    userId,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });
  return userId;
}

const key = () => `invoice-${(sequence += 1).toString().padStart(10, '0')}`;

interface Placed {
  userId: number;
  orderId: number;
}

async function placeOrder(userId?: number): Promise<Placed> {
  const buyer = userId ?? (await makeUser());
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 100,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '默认',
      price: '60.00',
      stock: 100,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  await harness.ctx.db.insert(cartItems).values({
    userId: buyer,
    productId: product!.id,
    skuId: sku!.id,
    quantity: 1,
    isSelected: true,
  });
  const detail = await order.create(as(buyer), {
    source: 'cart',
    cartItemIds: [],
    kind: 'normal',
    idempotencyKey: key(),
  });
  return { userId: buyer, orderId: Number(detail.id) };
}

async function paidOrder(userId?: number): Promise<Placed> {
  const placed = await placeOrder(userId);
  await withTx(harness.ctx.db, async (tx) => {
    const moved = await orderStateMachine.transition(
      tx,
      placed.orderId,
      ['pending_payment'],
      'paid',
      { at: harness.ctx.clock.now(), paidAmount: '60.00', transactionNo: `WX-${placed.orderId}` },
    );
    if (!moved.won) throw new Error('could not pay');
    const [row] = await tx.select().from(orders).where(eq(orders.id, placed.orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId: placed.orderId,
      orderNo: row!.orderNo,
      userId: row!.userId,
      paidAmount: Money.parse('60.00'),
      at: harness.ctx.clock.now(),
    });
  });
  harness.queue.reset();
  return placed;
}

const header = {
  headerType: 'personal' as const,
  invoiceType: 'plain' as const,
  name: '张三',
};

const companyHeader = {
  headerType: 'company' as const,
  invoiceType: 'special' as const,
  name: '杭州某某科技有限公司',
  dutyNumber: '91330100MA2XXXXXXX',
  registeredAddress: '杭州市文三路 100 号',
  registeredTel: '0571-88888888',
  bankName: '中国银行杭州分行',
  bankAccount: '1234567890',
};

const invoiceListQuery = (over: Record<string, unknown> = {}) =>
  ({ page: 1, pageSize: 20, sortBy: 'id', sortOrder: 'desc', ...over }) as never;

const logsOf = async (orderId: number) =>
  harness.ctx.db.select().from(orderStatusLogs).where(eq(orderStatusLogs.orderId, orderId));

// ---------------------------------------------------------------------------
// 申请开票
// ---------------------------------------------------------------------------

describe('申请开票', () => {
  it('INVOICE-004 — 订单详情 offers 申请开票 until a request is open, and again once it is cancelled', async () => {
    const placed = await paidOrder();
    const buyer = as(placed.userId);
    const before = await order.detail(buyer, { id: String(placed.orderId) });
    expect(before.invoiceRequestable).toBe(true);
    expect(before.invoiceAmount).toBe('60.00');

    const invoice = await order.orderInvoices.request(
      buyer,
      { id: String(placed.orderId) },
      header,
    );
    expect((await order.detail(buyer, { id: String(placed.orderId) })).invoiceRequestable).toBe(
      false,
    );

    await order.orderInvoices.cancel(buyer, { id: invoice.id });
    expect((await order.detail(buyer, { id: String(placed.orderId) })).invoiceRequestable).toBe(
      true,
    );
  });

  it('freezes what the buyer paid and what they typed', async () => {
    const placed = await paidOrder();
    const invoice = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      companyHeader,
    );

    expect(invoice.status).toBe('requested');
    expect(invoice.amount).toBe('60.00');
    expect(invoice.name).toBe(companyHeader.name);
    expect(invoice.dutyNumber).toBe(companyHeader.dutyNumber);
    expect(invoice.invoiceNumber).toBeNull();
    expect(invoice.issuedAt).toBeNull();
    expect(invoice.orderNo).toBeTruthy();

    expect(
      (await logsOf(placed.orderId)).some((log) => log.changeType === 'invoice_requested'),
    ).toBe(true);
  });

  it('carries the order’s line summary, read from the order rather than copied', async () => {
    const placed = await paidOrder();
    const invoice = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );

    expect(invoice.orderSummary).toEqual({
      productName: expect.stringMatching(/^商品\d+$/),
      productImageUrl: 'https://cdn.example.com/p.jpg',
      specText: '默认',
      quantity: 1,
      lineCount: 1,
      totalQuantity: 1,
    });

    // Not a copy: renaming the product changes what the invoice record shows,
    // because the summary is read from `order_items` on the way out.
    const items = await harness.ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));
    await harness.ctx.db
      .update(orderItems)
      .set({ snapshot: { ...items[0]!.snapshot, productName: '改过名的商品' } })
      .where(eq(orderItems.id, items[0]!.id));

    const again = await order.orderInvoices.myDetail(as(placed.userId), { id: invoice.id });
    expect(again.orderSummary?.productName).toBe('改过名的商品');

    const listed = await order.orderInvoices.myList(as(placed.userId), invoiceListQuery());
    expect(listed.items[0]?.orderSummary?.productName).toBe('改过名的商品');
  });

  it('is for what the buyer kept, not what they first paid', async () => {
    const placed = await paidOrder();
    // A partial refund has already gone back: 20.00 of the 60.00.
    await harness.ctx.db
      .update(orders)
      .set({ refundedAmount: '20.00', refundStatus: 'partially_refunded' })
      .where(eq(orders.id, placed.orderId));

    const invoice = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    expect(invoice.amount).toBe('40.00');
  });

  it('refuses an order nobody has paid for', async () => {
    const placed = await placeOrder();
    await expect(
      order.orderInvoices.request(as(placed.userId), { id: String(placed.orderId) }, header),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_REQUESTABLE' });
  });

  it('refuses an order whose money went back', async () => {
    const placed = await paidOrder();
    await harness.ctx.db
      .update(orders)
      .set({ refundStatus: 'refunded' })
      .where(eq(orders.id, placed.orderId));

    await expect(
      order.orderInvoices.request(as(placed.userId), { id: String(placed.orderId) }, header),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_REQUESTABLE' });
  });

  it('refuses a stranger the same way it refuses a missing order', async () => {
    const placed = await paidOrder();
    await expect(
      order.orderInvoices.request(as(await makeUser()), { id: String(placed.orderId) }, header),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('allows exactly one open request per order', async () => {
    const placed = await paidOrder();
    await order.orderInvoices.request(as(placed.userId), { id: String(placed.orderId) }, header);
    await expect(
      order.orderInvoices.request(as(placed.userId), { id: String(placed.orderId) }, header),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_ALREADY_OPEN' });
    expect(
      await harness.ctx.db
        .select()
        .from(orderInvoices)
        .where(eq(orderInvoices.orderId, placed.orderId)),
    ).toHaveLength(1);
  });

  /** The index only covers `requested` and `issued`, so a withdrawn one frees the slot. */
  it('lets the buyer ask again after cancelling, with a corrected header', async () => {
    const placed = await paidOrder();
    const first = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    await order.orderInvoices.cancel(as(placed.userId), { id: first.id });

    const second = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      companyHeader,
    );
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(companyHeader.name);
  });

  it('gives the slot to exactly one of several simultaneous requests', async () => {
    const placed = await paidOrder();
    const report = await runConcurrently(
      5,
      async () => {
        const ctx = forkTestCtx(harness, { actor: userActor(placed.userId), platform: 'h5' });
        try {
          await order.orderInvoices.request(ctx, { id: String(placed.orderId) }, header);
          return { won: true, code: 'ok' };
        } catch (error) {
          return { won: false, code: (error as { code?: string }).code ?? 'unknown' };
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(new Set(report.fulfilled.filter((o) => !o.won).map((o) => o.code))).toEqual(
      new Set(['ORDER_INVOICE_ALREADY_OPEN']),
    );
    expect(
      await harness.ctx.db
        .select()
        .from(orderInvoices)
        .where(eq(orderInvoices.orderId, placed.orderId)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the buyer's own list
// ---------------------------------------------------------------------------

describe('what the buyer can see', () => {
  it('lists their own invoices and nobody else’s', async () => {
    const mine = await paidOrder();
    const theirs = await paidOrder();
    await order.orderInvoices.request(as(mine.userId), { id: String(mine.orderId) }, header);
    await order.orderInvoices.request(as(theirs.userId), { id: String(theirs.orderId) }, header);

    const list = await order.orderInvoices.myList(as(mine.userId), invoiceListQuery());
    expect(list.total).toBe(1);
    expect(list.items[0]!.orderId).toBe(String(mine.orderId));
  });

  it('tells a stranger the invoice does not exist', async () => {
    const placed = await paidOrder();
    const invoice = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    await expect(
      order.orderInvoices.myDetail(as(await makeUser()), { id: invoice.id }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_FOUND' });
    await expect(
      order.orderInvoices.cancel(as(await makeUser()), { id: invoice.id }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_FOUND' });
  });

  it('refuses to withdraw one that has already been issued', async () => {
    const adminId = await makeAdmin();
    const placed = await paidOrder();
    const invoice = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoice.id },
      { invoiceNumber: 'FP-0001' },
    );

    await expect(
      order.orderInvoices.cancel(as(placed.userId), { id: invoice.id }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_ACTIONABLE' });
  });
});

// ---------------------------------------------------------------------------
// 开票 / 驳回
// ---------------------------------------------------------------------------

describe('the operator', () => {
  async function requested(): Promise<{ adminId: number; placed: Placed; invoiceId: string }> {
    const adminId = await makeAdmin();
    const placed = await paidOrder();
    const invoice = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    return { adminId, placed, invoiceId: invoice.id };
  }

  it('issues one, and the CHECK is what guarantees the number is there', async () => {
    const { adminId, placed, invoiceId } = await requested();
    const issued = await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoiceId },
      { invoiceNumber: 'FP-20260601-0001', remark: '已邮寄' },
    );

    expect(issued.status).toBe('issued');
    expect(issued.invoiceNumber).toBe('FP-20260601-0001');
    expect(issued.issuedAt).toBe(NOW);
    expect(issued.remark).toBe('已邮寄');

    const log = (await logsOf(placed.orderId)).find(
      (entry) => entry.changeType === 'invoice_issued',
    );
    expect(log).toMatchObject({ operatorKind: 'admin', operatorAdminId: adminId });
  });

  it('issues for what is left when a refund lands after the request', async () => {
    const { adminId, placed, invoiceId } = await requested();
    await harness.ctx.db
      .update(orders)
      .set({ refundedAmount: '15.50', refundStatus: 'partially_refunded' })
      .where(eq(orders.id, placed.orderId));

    const issued = await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoiceId },
      { invoiceNumber: 'FP-20260601-0002' },
    );
    expect(issued.amount).toBe('44.50');
  });

  it('refuses to issue once the whole order has been refunded', async () => {
    const { adminId, placed, invoiceId } = await requested();
    await harness.ctx.db
      .update(orders)
      .set({ refundedAmount: '60.00', refundStatus: 'refunded', status: 'refunded' })
      .where(eq(orders.id, placed.orderId));

    await expect(
      order.orderInvoices.adminIssue(
        asAdmin(adminId),
        { id: invoiceId },
        { invoiceNumber: 'FP-20260601-0003' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_ACTIONABLE' });
    expect(
      (await order.orderInvoices.adminDetail(asAdmin(adminId), { id: invoiceId })).status,
    ).toBe('requested');
  });

  it('INVOICE-005 — keeps an issued invoice 已开票 when the order is refunded in full, flags it for 冲红, and lets staff void it', async () => {
    const { adminId, placed, invoiceId } = await requested();
    await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoiceId },
      { invoiceNumber: 'FP-20260601-0005' },
    );
    await harness.ctx.db
      .update(orders)
      .set({ refundedAmount: '60.00', refundStatus: 'refunded', status: 'refunded' })
      .where(eq(orders.id, placed.orderId));

    const flagged = await order.orderInvoices.adminDetail(asAdmin(adminId), { id: invoiceId });
    expect(flagged).toMatchObject({
      status: 'issued',
      invoiceNumber: 'FP-20260601-0005',
      orderRefundedInFull: true,
      voided: false,
    });
    const listed = await order.orderInvoices.adminList(asAdmin(adminId), invoiceListQuery());
    expect(listed.items.find((item) => item.id === invoiceId)?.orderRefundedInFull).toBe(true);

    const voided = await order.orderInvoices.adminVoid(asAdmin(adminId), { id: invoiceId });
    expect(voided).toMatchObject({
      status: 'cancelled',
      invoiceNumber: 'FP-20260601-0005',
      issuedAt: null,
      voided: true,
    });
    const voidLogs = (await logsOf(placed.orderId)).filter(
      (entry) => entry.changeType === 'invoice_voided',
    );
    expect(voidLogs).toEqual([
      expect.objectContaining({
        message: '作废发票 FP-20260601-0005',
        operatorKind: 'admin',
        operatorAdminId: adminId,
      }),
    ]);
    await expect(
      order.orderInvoices.adminVoid(asAdmin(adminId), { id: invoiceId }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_ACTIONABLE' });
    // Nothing is left to invoice: the refunded order cannot ask again.
    await expect(
      order.orderInvoices.request(as(placed.userId), { id: String(placed.orderId) }, header),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_REQUESTABLE' });
  });

  it('INVOICE-005 — voids only an issued invoice, and a voided one frees the order to ask again', async () => {
    const { adminId, placed, invoiceId } = await requested();
    await expect(
      order.orderInvoices.adminVoid(asAdmin(adminId), { id: invoiceId }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_ACTIONABLE' });
    expect(
      (await order.orderInvoices.adminDetail(asAdmin(adminId), { id: invoiceId })).status,
    ).toBe('requested');

    await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoiceId },
      { invoiceNumber: 'FP-20260601-0006' },
    );
    await order.orderInvoices.adminVoid(asAdmin(adminId), { id: invoiceId });
    const again = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    expect(again).toMatchObject({ status: 'requested', voided: false, orderRefundedInFull: false });
    // The buyer's own withdrawal is still 已撤回, not 已作废.
    const withdrawn = await order.orderInvoices.cancel(as(placed.userId), { id: again.id });
    expect(withdrawn).toMatchObject({ status: 'cancelled', voided: false });
  });

  it('refuses to issue the same invoice twice', async () => {
    const { adminId, invoiceId } = await requested();
    await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoiceId },
      { invoiceNumber: 'FP-1' },
    );
    await expect(
      order.orderInvoices.adminIssue(
        asAdmin(adminId),
        { id: invoiceId },
        { invoiceNumber: 'FP-2' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_ACTIONABLE' });
  });

  it('issues it to exactly one of two operators pressing at once', async () => {
    const { invoiceId } = await requested();
    const first = await makeAdmin();
    const second = await makeAdmin();

    const report = await runConcurrently(
      2,
      async (index) => {
        const ctx = forkTestCtx(harness, {
          actor: adminActor(index === 0 ? first : second),
          platform: null,
        });
        try {
          await order.orderInvoices.adminIssue(
            ctx,
            { id: invoiceId },
            { invoiceNumber: `FP-${index}` },
          );
          return { won: true };
        } catch {
          return { won: false };
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    const [row] = await harness.ctx.db.select().from(orderInvoices);
    expect(row!.status).toBe('issued');
    expect(row!.invoiceNumber).toMatch(/^FP-[01]$/);
  });

  it('rejects one with the reason the buyer will be shown', async () => {
    const { adminId, placed, invoiceId } = await requested();
    const rejected = await order.orderInvoices.adminReject(
      asAdmin(adminId),
      { id: invoiceId },
      { reason: '抬头与付款方不一致' },
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.remark).toBe('抬头与付款方不一致');

    const log = (await logsOf(placed.orderId)).find(
      (entry) => entry.changeType === 'invoice_rejected',
    );
    expect(log?.message).toContain('抬头与付款方不一致');

    // A rejection frees the slot, so the buyer can fix it and ask again.
    const again = await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      header,
    );
    expect(again.status).toBe('requested');
  });

  it('refuses to act on an invoice that is not there', async () => {
    const adminId = await makeAdmin();
    await expect(
      order.orderInvoices.adminDetail(asAdmin(adminId), { id: '999999' }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_FOUND' });
    await expect(
      order.orderInvoices.adminIssue(asAdmin(adminId), { id: '999999' }, { invoiceNumber: 'FP-X' }),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_NOT_FOUND' });
  });

  it('filters the console list by status', async () => {
    const { adminId, invoiceId } = await requested();
    const other = await paidOrder();
    await order.orderInvoices.request(as(other.userId), { id: String(other.orderId) }, header);
    await order.orderInvoices.adminIssue(
      asAdmin(adminId),
      { id: invoiceId },
      { invoiceNumber: 'FP-9' },
    );

    const all = await order.orderInvoices.adminList(asAdmin(adminId), invoiceListQuery());
    expect(all.total).toBe(2);

    const open = await order.orderInvoices.adminList(
      asAdmin(adminId),
      invoiceListQuery({ status: ['requested'] }),
    );
    expect(open.total).toBe(1);
    expect(open.items[0]!.status).toBe('requested');
  });
});

// ---------------------------------------------------------------------------
// the constraints themselves
// ---------------------------------------------------------------------------

describe('the database itself', () => {
  it('refuses an issued invoice with no number', async () => {
    const placed = await paidOrder();
    const error = await harness.ctx.db
      .insert(orderInvoices)
      .values({
        orderId: placed.orderId,
        userId: placed.userId,
        status: 'issued',
        headerType: 'personal',
        invoiceType: 'plain',
        name: '张三',
        amount: '60.00',
        issuedAt: new Date(NOW),
        invoiceNumber: null,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect((error as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      'order_invoices_issued_shape',
    );
  });
});
