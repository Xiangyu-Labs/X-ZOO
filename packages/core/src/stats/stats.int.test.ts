import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  productCategories,
  productCategoriesMap,
  products,
  productFavorites,
  productSkus,
} from '@shop/db/schema/catalog';
import { orderItems, orders } from '@shop/db/schema/order';
import { refundItems, refunds } from '@shop/db/schema/refund';
import { productEvents, userVisits } from '@shop/db/schema/stats';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { DomainError } from '../kernel/errors';
import { clearStatsCache } from './stats.cache';
import { statsConfig } from './stats.config';
import * as stats from './stats.service';

/**
 * The statistics domain against a real PostgreSQL 17.
 *
 * ## The fixture
 *
 * Six orders and two refunds around a Shanghai day boundary, plus the traffic
 * and after-sales rows that go with them. It is written out once, every
 * expected figure is derived from it by hand in the table below, and every
 * block is asserted against those numbers — which is the only way a
 * "statistics are right" claim means anything.
 *
 * The boundary is the point of the shape: **O2 is paid at 23:30 on the 1st and
 * O3 at 00:30 on the 2nd, Shanghai time, and both are the same UTC day.** A
 * UTC-bucketed report puts them in one bucket; every figure below says they
 * are in two. The same trick is played on the refund side, where R2 succeeds
 * at 23:45 on the 3rd.
 *
 * | Window 2026-02-01 → 2026-02-03 (3 Shanghai days, `day` buckets) |         |
 * | ---------------------------------------------------------------- | ------- |
 * | paid orders (O1 O2 O3 O4)                                        | 4       |
 * | 订单销售额 `Σ paid_amount`                                        | 650.00  |
 * | 商品支付金额 `Σ order_items.total_amount`                          | 635.00  |
 * | 运费收入                                                          | 15.00   |
 * | 退款金额 (R1 45 + R2 100)                                         | 145.00  |
 * | 营业额 650 − 145                                                  | 505.00  |
 * | 客单价 505 ÷ 4                                                    | 126.25  |
 * | 下单件数 (O1 2, O2 1, O3 1, O4 3, O5 2)                           | 9       |
 * | 支付件数 (O1 2, O2 1, O3 1, O4 3)                                 | 7       |
 * | 新增用户 (U1 U2 U3)                                               | 3       |
 * | 累计用户 (U1..U4; U5 is cancelled)                                 | 4       |
 * | 成交用户数 (U1 twice, U2, U3)                                      | 3       |
 * | 浏览量 / 访客数 (4 page views, 2 identities)                       | 4 / 2   |
 * | 平均停留时长 (30 s and 90 s reported, two views without a report)  | 60 s    |
 * | 商品浏览量 / 商品访客数                                             | 6 / 4   |
 *
 * O6 is paid on 2026-01-31 and O5 is never paid: both exist so that "inside
 * the window" and "paid" are separately proven, rather than a fixture where
 * every row counts towards everything.
 */

let harness: TestCtx;

const NOW = '2026-02-04T10:00:00+08:00';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  await harness.ctx.redis.flushdb();
  await seed();
});

const WINDOW = { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' };

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

const userIds: Record<string, number> = {};
const productIds: Record<string, number> = {};
const skuIds: Record<string, number> = {};
const orderIds: Record<string, number> = {};
const orderItemIds: Record<string, number> = {};

const at = (iso: string): Date => new Date(iso);

async function seed(): Promise<void> {
  const db = harness.ctx.db;

  const userRows = await db
    .insert(users)
    .values([
      { account: 'u1', nickname: 'U1', createdAt: at('2026-02-01T08:00:00+08:00') },
      { account: 'u2', nickname: 'U2', createdAt: at('2026-02-01T09:00:00+08:00') },
      { account: 'u3', nickname: 'U3', createdAt: at('2026-02-02T10:00:00+08:00') },
      { account: 'u4', nickname: 'U4', createdAt: at('2026-01-20T10:00:00+08:00') },
      {
        account: 'u5',
        nickname: 'U5',
        createdAt: at('2026-01-10T10:00:00+08:00'),
        deletedAt: at('2026-01-25T10:00:00+08:00'),
      },
    ])
    .returning({ id: users.id, account: users.account });
  for (const row of userRows) userIds[row.account] = row.id;

  await db
    .insert(userAddresses)
    .values([address('u1', '浙江'), address('u2', '广东'), address('u4', '浙江')]);

  for (const [key, name] of [
    ['p1', '云南小粒咖啡豆 500g'],
    ['p2', '手冲壶'],
  ] as const) {
    const [product] = await db
      .insert(products)
      .values({
        name,
        imageUrl: `/uploads/${key}.png`,
        status: 'on_shelf',
        price: '100.00',
        freightMode: 'free',
      })
      .returning({ id: products.id });
    productIds[key] = product!.id;
    const [sku] = await db
      .insert(productSkus)
      .values({
        productId: product!.id,
        skuCode: `SKU-${key}`,
        price: '100.00',
        stock: 100,
        isDefault: true,
      })
      .returning({ id: productSkus.id });
    skuIds[key] = sku!.id;
  }

  // O1 — paid on the 1st, later partly refunded.
  await order('o1', {
    user: 'u1',
    platform: 'wechat_mini',
    kind: 'normal',
    createdAt: '2026-02-01T09:50:00+08:00',
    paidAt: '2026-02-01T10:00:00+08:00',
    paidAmount: '100.00',
    freight: '10.00',
    province: '浙江',
    refundedAmount: '45.00',
    lines: [{ key: 'p1', quantity: 2, total: '90.00' }],
  });

  // O2 — 23:30 on the 1st, Shanghai. Same UTC day as O3.
  await order('o2', {
    user: 'u2',
    platform: 'wechat_mini',
    kind: 'normal',
    createdAt: '2026-02-01T23:20:00+08:00',
    paidAt: '2026-02-01T23:30:00+08:00',
    paidAmount: '200.00',
    freight: '0.00',
    province: '广东',
    lines: [{ key: 'p2', quantity: 1, total: '200.00' }],
  });

  // O3 — 00:30 on the 2nd, Shanghai. The other side of the boundary.
  await order('o3', {
    user: 'u1',
    platform: 'wechat_mini',
    kind: 'normal',
    createdAt: '2026-02-02T00:20:00+08:00',
    paidAt: '2026-02-02T00:30:00+08:00',
    paidAmount: '50.00',
    freight: '5.00',
    province: '浙江',
    lines: [{ key: 'p1', quantity: 1, total: '45.00' }],
  });

  // O4 — a group buy on the 3rd, refunded the same evening.
  await order('o4', {
    user: 'u3',
    platform: 'h5',
    kind: 'groupbuy',
    createdAt: '2026-02-03T11:00:00+08:00',
    paidAt: '2026-02-03T12:00:00+08:00',
    paidAmount: '300.00',
    freight: '0.00',
    province: '上海',
    refundedAmount: '100.00',
    lines: [{ key: 'p2', quantity: 3, total: '300.00' }],
  });

  // O5 — submitted inside the window and never paid.
  await order('o5', {
    user: 'u4',
    platform: 'h5',
    kind: 'normal',
    createdAt: '2026-02-03T20:00:00+08:00',
    paidAt: null,
    paidAmount: null,
    freight: '0.00',
    province: '浙江',
    lines: [{ key: 'p1', quantity: 2, total: '90.00' }],
  });

  // O6 — paid the day before the window opens.
  await order('o6', {
    user: 'u2',
    platform: 'h5',
    kind: 'normal',
    createdAt: '2026-01-31T22:00:00+08:00',
    paidAt: '2026-01-31T23:00:00+08:00',
    paidAmount: '400.00',
    freight: '0.00',
    province: '广东',
    lines: [{ key: 'p2', quantity: 1, total: '400.00' }],
  });

  await refund('r1', {
    order: 'o1',
    user: 'u1',
    item: 'o1',
    quantity: 1,
    amount: '45.00',
    succeededAt: '2026-02-02T09:00:00+08:00',
  });
  await refund('r2', {
    order: 'o4',
    user: 'u3',
    item: 'o4',
    quantity: 1,
    amount: '100.00',
    // 23:45 on the 3rd, Shanghai: the last minutes of the window.
    succeededAt: '2026-02-03T23:45:00+08:00',
  });
  // A refund that is still open counts nowhere.
  await refund('r3', {
    order: 'o2',
    user: 'u2',
    item: 'o2',
    quantity: 1,
    amount: '200.00',
    succeededAt: null,
  });

  await db.insert(productEvents).values([
    event('p1', 'u1', 'view', '2026-02-01T09:00:00+08:00'),
    event('p1', 'u2', 'view', '2026-02-01T09:30:00+08:00'),
    event('p1', null, 'view', '2026-02-02T09:00:00+08:00'),
    event('p2', 'u1', 'view', '2026-02-03T09:00:00+08:00'),
    event('p2', 'u3', 'view', '2026-02-02T08:00:00+08:00'),
    event('p1', 'u4', 'view', '2026-02-03T08:00:00+08:00'),
    { ...event('p1', 'u1', 'cart', '2026-02-01T09:10:00+08:00'), quantity: 2 },
    // Outside the window.
    event('p1', 'u1', 'view', '2026-01-20T09:00:00+08:00'),
  ]);

  await db.insert(productFavorites).values([
    {
      userId: userIds.u1!,
      productId: productIds.p2!,
      createdAt: at('2026-02-02T10:00:00+08:00'),
    },
  ]);

  await db
    .insert(userVisits)
    .values([
      visit('u1', '1.1.1.1', '浙江', '2026-02-01T10:00:00+08:00', 30_000),
      visit(null, '2.2.2.2', '广东', '2026-02-01T11:00:00+08:00', 90_000),
      visit('u1', '1.1.1.1', '浙江', '2026-02-02T10:00:00+08:00'),
      visit(null, '2.2.2.2', '广东', '2026-02-02T11:00:00+08:00'),
      visit('u1', '1.1.1.1', '浙江', '2026-01-20T11:00:00+08:00', 600_000),
    ]);
}

function address(user: string, province: string) {
  return {
    userId: userIds[user]!,
    receiverName: user,
    receiverPhone: '13800000000',
    provinceName: province,
    cityName: '市',
    detail: '某处',
    isDefault: true,
  };
}

function event(product: string, user: string | null, kind: 'view' | 'cart', when: string) {
  return {
    productId: productIds[product]!,
    userId: user === null ? null : userIds[user]!,
    kind,
    quantity: 1,
    createdAt: at(when),
  };
}

function visit(
  user: string | null,
  ip: string,
  province: string,
  when: string,
  stayMs: number | null = null,
) {
  return {
    userId: user === null ? null : userIds[user]!,
    path: '/pages/index',
    platform: 'h5' as const,
    ip,
    province,
    stayMs,
    createdAt: at(when),
  };
}

async function order(
  key: string,
  spec: {
    user: string;
    platform: 'h5' | 'wechat_oa' | 'wechat_mini';
    kind: 'normal' | 'groupbuy' | 'presale';
    createdAt: string;
    paidAt: string | null;
    paidAmount: string | null;
    freight: string;
    province: string;
    refundedAmount?: string;
    lines: Array<{ key: string; quantity: number; total: string }>;
  },
): Promise<void> {
  const db = harness.ctx.db;
  const itemsAmount = spec.lines.reduce((sum, line) => sum + Number(line.total), 0).toFixed(2);
  const [row] = await db
    .insert(orders)
    .values({
      orderNo: `NO-${key}`,
      userId: userIds[spec.user]!,
      kind: spec.kind,
      status: spec.paidAt === null ? 'pending_payment' : 'paid',
      platform: spec.platform,
      totalQuantity: spec.lines.reduce((sum, line) => sum + line.quantity, 0),
      itemsAmount,
      freightAmount: spec.freight,
      payableAmount: (Number(itemsAmount) + Number(spec.freight)).toFixed(2),
      paidAmount: spec.paidAmount,
      refundedAmount: spec.refundedAmount ?? '0.00',
      paidAt: spec.paidAt === null ? null : at(spec.paidAt),
      receiverName: '收件人',
      receiverPhone: '13800000000',
      receiverProvince: spec.province,
      receiverCity: '市',
      receiverDetail: '某处',
      createdAt: at(spec.createdAt),
    })
    .returning({ id: orders.id });
  orderIds[key] = row!.id;

  let index = 0;
  for (const line of spec.lines) {
    index += 1;
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: row!.id,
        productId: productIds[line.key]!,
        skuId: skuIds[line.key]!,
        itemKey: `${key}-${index}`,
        quantity: line.quantity,
        unitPrice: (Number(line.total) / line.quantity).toFixed(2),
        totalAmount: line.total,
        snapshot: {
          productName: line.key,
          productImageUrl: '/x.png',
          productKind: 'physical',
          skuCode: `SKU-${line.key}`,
          specText: '默认',
          specValues: {},
        },
        createdAt: at(spec.createdAt),
      })
      .returning({ id: orderItems.id });
    if (index === 1) orderItemIds[key] = item!.id;
  }
}

async function refund(
  key: string,
  spec: {
    order: string;
    user: string;
    item: string;
    quantity: number;
    amount: string;
    succeededAt: string | null;
  },
): Promise<void> {
  const db = harness.ctx.db;
  const [row] = await db
    .insert(refunds)
    .values({
      refundNo: `RF-${key}`,
      outRefundNo: `OUT-${key}`,
      orderId: orderIds[spec.order]!,
      userId: userIds[spec.user]!,
      kind: 'refund_only',
      status: spec.succeededAt === null ? 'applied' : 'succeeded',
      quantity: spec.quantity,
      amount: spec.amount,
      refundedAmount: spec.succeededAt === null ? '0.00' : spec.amount,
      succeededAt: spec.succeededAt === null ? null : at(spec.succeededAt),
      createdAt: at(spec.succeededAt ?? '2026-02-02T08:00:00+08:00'),
    })
    .returning({ id: refunds.id });

  await db.insert(refundItems).values({
    refundId: row!.id,
    orderItemId: orderItemIds[spec.item]!,
    quantity: spec.quantity,
    amount: spec.amount,
    isOpen: spec.succeededAt === null,
  });
}

/** The tile of a page, by key. */
function tile(
  page: { metrics: Array<{ key: string; value: number; previous: number | null }> },
  key: string,
) {
  const found = page.metrics.find((metric) => metric.key === key);
  if (found === undefined) throw new Error(`no metric ${key}`);
  return found;
}

function line(
  page: { chart: { series: Array<{ name: string; values: number[] }> } },
  name: string,
) {
  const found = page.chart.series.find((series) => series.name === name);
  if (found === undefined) throw new Error(`no series ${name}`);
  return found.values;
}

// ---------------------------------------------------------------------------
// 交易统计
// ---------------------------------------------------------------------------

describe('trade', () => {
  it('reports the documented figures for the fixture window', async () => {
    const page = await stats.tradeStats(harness.ctx, WINDOW);

    expect(page.from).toBe('2026-01-31T16:00:00.000Z');
    expect(page.to).toBe('2026-02-03T16:00:00.000Z');
    expect(page.chart.bucket).toBe('day');
    expect(page.chart.buckets).toEqual(['2026-02-01', '2026-02-02', '2026-02-03']);

    expect(tile(page, 'revenue').value).toBe(505);
    expect(tile(page, 'goodsPaidAmount').value).toBe(635);
    expect(tile(page, 'refundAmount').value).toBe(145);
    expect(tile(page, 'freightAmount').value).toBe(15);
    expect(tile(page, 'paidOrderCount').value).toBe(4);
    expect(tile(page, 'averageOrderValue').value).toBe(126.25);
  });

  it('puts 23:30 and 00:30 Shanghai in different day buckets', async () => {
    const page = await stats.tradeStats(harness.ctx, WINDOW);
    // O2 (200.00) on the 1st, O3 (50.00) on the 2nd — one UTC day, two
    // Shanghai days. A UTC-bucketed report would show 300 / 0 / 300.
    expect(line(page, '商品支付金额')).toEqual([290, 45, 300]);
    expect(line(page, '营业额')).toEqual([300, 5, 200]);
    expect(line(page, '商品退款金额')).toEqual([0, 45, 100]);
  });

  it('compares against the three days before the window', async () => {
    const page = await stats.tradeStats(harness.ctx, WINDOW);
    // Only O6, paid on 2026-01-31 for 400.00, is in 01-29 → 01-31.
    expect(tile(page, 'revenue').previous).toBe(400);
    expect(tile(page, 'paidOrderCount').previous).toBe(1);
  });

  it('excludes an order an operator deleted', async () => {
    await harness.ctx.db.update(orders).set({ deletedAt: at(NOW) });
    const page = await stats.tradeStats(harness.ctx, WINDOW);
    // Its refunds go with it: a deleted order's money is neither in nor out.
    expect(tile(page, 'revenue').value).toBe(0);
    expect(tile(page, 'paidOrderCount').value).toBe(0);
    expect(line(page, '商品退款金额')).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// 订单统计
// ---------------------------------------------------------------------------

describe('orders', () => {
  it('counts paid orders, refunded orders and both breakdowns', async () => {
    const page = await stats.orderStats(harness.ctx, WINDOW);

    expect(tile(page, 'paidOrderCount').value).toBe(4);
    expect(tile(page, 'paidAmount').value).toBe(650);
    expect(tile(page, 'refundOrderCount').value).toBe(2);
    expect(tile(page, 'refundAmount').value).toBe(145);
    expect(tile(page, 'refundRate').value).toBe(50);

    const platform = page.breakdowns.find((row) => row.key === 'platform');
    expect(platform?.rows).toEqual([
      { key: 'wechat_mini', label: '小程序', value: 3, percent: 75 },
      { key: 'h5', label: 'H5', value: 1, percent: 25 },
    ]);

    const kind = page.breakdowns.find((row) => row.key === 'kind');
    expect(kind?.rows).toEqual([
      { key: 'normal', label: '普通订单', value: 350, percent: 53.85 },
      { key: 'groupbuy', label: '拼团订单', value: 300, percent: 46.15 },
    ]);
    // 预售 never happened in this window, so it is absent rather than 0 %.
    expect(kind?.rows.some((row) => row.key === 'presale')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 销售看板
// ---------------------------------------------------------------------------

/**
 * Two roots, 咖啡 with two children and 器具 with none. p1 is filed under both
 * children of 咖啡 *and* under 器具; p2 is in no category. So p1's lines (O1
 * and O3: 3 件, 135.00, 2 orders) appear once under 咖啡 and once under 器具,
 * and p2's (O2 and O4: 4 件, 500.00) are 未分类.
 */
async function seedCategories(): Promise<{ coffee: number; tools: number }> {
  const db = harness.ctx.db;
  const [coffee] = await db
    .insert(productCategories)
    .values({ name: '咖啡', path: '/', level: 0 })
    .returning({ id: productCategories.id });
  const [tools] = await db
    .insert(productCategories)
    .values({ name: '器具', path: '/', level: 0 })
    .returning({ id: productCategories.id });
  const children = await db
    .insert(productCategories)
    .values([
      { name: '咖啡豆', parentId: coffee!.id, path: `/${coffee!.id}/`, level: 1 },
      { name: '挂耳', parentId: coffee!.id, path: `/${coffee!.id}/`, level: 1 },
    ])
    .returning({ id: productCategories.id });
  await db
    .insert(productCategoriesMap)
    .values([
      ...children.map((child) => ({ productId: productIds.p1!, categoryId: child.id })),
      { productId: productIds.p1!, categoryId: tools!.id },
    ]);
  return { coffee: coffee!.id, tools: tools!.id };
}

describe('sales', () => {
  it('shows the same figures as 交易统计 and 订单统计 for the window', async () => {
    const page = await stats.salesStats(harness.ctx, WINDOW);

    expect(tile(page, 'revenue').value).toBe(505);
    expect(tile(page, 'goodsPaidAmount').value).toBe(635);
    expect(tile(page, 'paidOrderCount').value).toBe(4);
    expect(tile(page, 'averageOrderValue').value).toBe(126.25);
    expect(tile(page, 'paidQuantity').value).toBe(7);
    expect(tile(page, 'refundAmount').value).toBe(145);
    expect(tile(page, 'refundRate').value).toBe(50);
    expect(tile(page, 'revenue').previous).toBe(400);

    expect(line(page, '营业额')).toEqual([300, 5, 200]);
    expect(line(page, '支付订单数')).toEqual([2, 1, 1]);

    const orderPage = await stats.orderStats(harness.ctx, WINDOW);
    expect(page.breakdowns).toEqual(orderPage.breakdowns);
  });

  it('compares with the same Shanghai days a year earlier', async () => {
    const empty = await stats.salesStats(harness.ctx, WINDOW);
    expect(empty.metrics.every((metric) => metric.yearAgo === 0)).toBe(true);

    await order('o7', {
      user: 'u2',
      platform: 'h5',
      kind: 'normal',
      createdAt: '2025-02-02T14:50:00+08:00',
      paidAt: '2025-02-02T15:00:00+08:00',
      paidAmount: '80.00',
      freight: '0.00',
      province: '广东',
      lines: [{ key: 'p1', quantity: 1, total: '80.00' }],
    });
    // A year and a day earlier is outside 去年同期.
    await order('o8', {
      user: 'u2',
      platform: 'h5',
      kind: 'normal',
      createdAt: '2025-01-31T23:50:00+08:00',
      paidAt: '2025-01-31T23:59:00+08:00',
      paidAmount: '999.00',
      freight: '0.00',
      province: '广东',
      lines: [{ key: 'p1', quantity: 1, total: '999.00' }],
    });
    await harness.ctx.redis.flushdb();

    const page = await stats.salesStats(harness.ctx, WINDOW);
    const yearAgo = (key: string) => page.metrics.find((metric) => metric.key === key)?.yearAgo;
    expect(yearAgo('revenue')).toBe(80);
    expect(yearAgo('paidOrderCount')).toBe(1);
    expect(yearAgo('paidQuantity')).toBe(1);
    expect(yearAgo('averageOrderValue')).toBe(80);
    // 环比 is untouched by it.
    expect(tile(page, 'revenue').previous).toBe(400);
  });

  it('folds every day onto Shanghai hours 00–23', async () => {
    const page = await stats.salesStats(harness.ctx, WINDOW);

    expect(page.hourly.bucket).toBe('hour');
    expect(page.hourly.buckets).toHaveLength(24);
    expect(page.hourly.buckets[0]).toBe('00');
    expect(page.hourly.buckets[23]).toBe('23');

    const counts = page.hourly.series.find((series) => series.name === '支付订单数')!.values;
    const amounts = page.hourly.series.find((series) => series.name === '支付金额')!.values;
    // O3 at 00:30 and O2 at 23:30 Shanghai: hours 0 and 23, not one UTC hour 16/15.
    expect(counts[0]).toBe(1);
    expect(counts[10]).toBe(1);
    expect(counts[12]).toBe(1);
    expect(counts[23]).toBe(1);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(4);
    expect(amounts[0]).toBe(50);
    expect(amounts[10]).toBe(100);
    expect(amounts[12]).toBe(300);
    expect(amounts[23]).toBe(200);
  });

  it('puts every line under 未分类 when no product has a category', async () => {
    const page = await stats.salesStats(harness.ctx, WINDOW);
    expect(page.categories).toEqual([
      {
        categoryId: null,
        name: '未分类',
        paidAmount: 635,
        paidQuantity: 7,
        orderCount: 4,
        percent: 100,
      },
    ]);
  });

  it('rolls subcategories up to their root, once per root, and 未分类 last', async () => {
    const { coffee, tools } = await seedCategories();
    const page = await stats.salesStats(harness.ctx, WINDOW);

    expect(page.categories).toEqual([
      // 135.00 counted once under 咖啡 although p1 is in two of its children.
      {
        categoryId: String(coffee),
        name: '咖啡',
        paidAmount: 135,
        paidQuantity: 3,
        orderCount: 2,
        percent: 21.26,
      },
      // …and again under 器具, a second root: the shares add up past 100.
      {
        categoryId: String(tools),
        name: '器具',
        paidAmount: 135,
        paidQuantity: 3,
        orderCount: 2,
        percent: 21.26,
      },
      // Larger than both, still last.
      {
        categoryId: null,
        name: '未分类',
        paidAmount: 500,
        paidQuantity: 4,
        orderCount: 2,
        percent: 78.74,
      },
    ]);
  });

  it('leaves an order an operator deleted out of 时段分布 and 分类销售', async () => {
    await seedCategories();
    await harness.ctx.db.update(orders).set({ deletedAt: at(NOW) });
    const page = await stats.salesStats(harness.ctx, WINDOW);

    expect(page.categories).toEqual([]);
    for (const series of page.hourly.series) {
      expect(series.values.every((value) => value === 0)).toBe(true);
    }
  });

  it('exports the category table', async () => {
    await seedCategories();
    const file = await stats.salesExport(harness.ctx, WINDOW);

    expect(file.filename).toBe('分类销售-2026-02-01至2026-02-03.csv');
    expect(file.rowCount).toBe(3);
    expect(file.truncated).toBe(false);
    expect(file.content).toBe(
      '分类,支付金额,支付件数,支付订单数,占比(%)\n' +
        '咖啡,135.00,3,2,21.26\n' +
        '器具,135.00,3,2,21.26\n' +
        '未分类,500.00,4,2,78.74\n',
    );
  });

  it('refuses an export with more categories than the cap', async () => {
    // Ten roots holding p1, plus 未分类 for p2: eleven rows, ten allowed.
    const roots = await harness.ctx.db
      .insert(productCategories)
      .values(Array.from({ length: 10 }, (_, index) => ({ name: `分类${index}`, path: '/' })))
      .returning({ id: productCategories.id });
    await harness.ctx.db
      .insert(productCategoriesMap)
      .values(roots.map((root) => ({ productId: productIds.p1!, categoryId: root.id })));
    await harness.ctx.config.set(statsConfig, { exportMaxRows: 10 });

    await expect(stats.salesExport(harness.ctx, WINDOW)).rejects.toMatchObject({
      code: 'STATS_EXPORT_TOO_LARGE',
      details: { maxRows: 10, matched: 11 },
    });
  });
});

// ---------------------------------------------------------------------------
// 用户统计
// ---------------------------------------------------------------------------

describe('users', () => {
  it('counts registrations, buyers and traffic, and never sums a distinct count', async () => {
    const page = await stats.userStats(harness.ctx, WINDOW);

    expect(tile(page, 'newUsers').value).toBe(3);
    expect(tile(page, 'payingUsers').value).toBe(3);
    // U5 is cancelled, so the running total is four rather than five.
    expect(tile(page, 'totalUsers').value).toBe(4);
    expect(tile(page, 'totalUsers').previous).toBeNull();

    expect(tile(page, 'pageViews').value).toBe(4);
    // Two identities over the window — one signed-in user and one IP — although
    // the daily buckets say 2 and 2. Summing them would say four visitors.
    expect(tile(page, 'visitors').value).toBe(2);
    expect(line(page, '访客数')).toEqual([2, 2, 0]);
  });

  it('averages 停留时长 over the views that reported one, in seconds', async () => {
    const page = await stats.userStats(harness.ctx, WINDOW);

    // 30 s and 90 s; the two views with no report are absent from the
    // average, not zeros in it — otherwise it would read 30 s.
    expect(tile(page, 'avgStay')).toMatchObject({ value: 60, format: 'duration' });
    // Nothing was reported in the window before, which is a 0 and not a gap.
    expect(tile(page, 'avgStay').previous).toBe(0);
  });

  it('breaks the provinces out per column, and sorts 未知 last', async () => {
    const regions = await stats.userRegions(harness.ctx, {
      ...WINDOW,
      sortBy: 'totalUsers',
      limit: 10,
    });

    expect(regions.rows).toEqual([
      { province: '浙江', totalUsers: 2, newUsers: 1, visitors: 1, paidAmount: 150 },
      { province: '广东', totalUsers: 1, newUsers: 1, visitors: 1, paidAmount: 200 },
      { province: '上海', totalUsers: 0, newUsers: 0, visitors: 0, paidAmount: 300 },
      { province: '未知', totalUsers: 1, newUsers: 1, visitors: 0, paidAmount: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 商品统计
// ---------------------------------------------------------------------------

describe('products', () => {
  it('separates placed from paid quantities and counts anonymous views once', async () => {
    const page = await stats.productStats(harness.ctx, WINDOW);

    expect(tile(page, 'productViews').value).toBe(6);
    // The anonymous view counts towards 浏览量 and not towards 访客数.
    expect(tile(page, 'productVisitors').value).toBe(4);
    expect(tile(page, 'cartQuantity').value).toBe(2);
    expect(tile(page, 'orderQuantity').value).toBe(9);
    expect(tile(page, 'paidQuantity').value).toBe(7);
    expect(tile(page, 'paidAmount').value).toBe(635);
    expect(tile(page, 'refundQuantity').value).toBe(2);
    expect(tile(page, 'refundAmount').value).toBe(145);
    // 3 buyers ÷ 4 product visitors.
    expect(tile(page, 'payConversion').value).toBe(75);
  });

  it('ranks products by the asked-for figure, with every column per product', async () => {
    const ranking = await stats.productRanking(harness.ctx, {
      ...WINDOW,
      sortBy: 'paidAmount',
      limit: 20,
    });

    expect(ranking.rows).toEqual([
      {
        productId: String(productIds.p2),
        name: '手冲壶',
        imageUrl: '/uploads/p2.png',
        views: 2,
        visitors: 2,
        cartQuantity: 0,
        orderQuantity: 4,
        paidQuantity: 4,
        paidAmount: 500,
        favorites: 1,
        conversion: 100,
      },
      {
        productId: String(productIds.p1),
        name: '云南小粒咖啡豆 500g',
        imageUrl: '/uploads/p1.png',
        views: 4,
        visitors: 3,
        cartQuantity: 2,
        orderQuantity: 5,
        paidQuantity: 3,
        paidAmount: 135,
        favorites: 0,
        // One buyer (U1 bought twice) among three visitors.
        conversion: 33.33,
      },
    ]);
  });

  it('ranks by views when asked to, and honours the limit', async () => {
    const ranking = await stats.productRanking(harness.ctx, {
      ...WINDOW,
      sortBy: 'views',
      limit: 1,
    });
    expect(ranking.rows).toHaveLength(1);
    expect(ranking.rows[0]?.productId).toBe(String(productIds.p1));
  });
});

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

describe('exports', () => {
  it('writes the trade window as one CSV row per bucket', async () => {
    const file = await stats.tradeExport(harness.ctx, WINDOW);

    expect(file.filename).toBe('交易统计-2026-02-01至2026-02-03.csv');
    expect(file.contentType).toBe('text/csv');
    expect(file.rowCount).toBe(3);
    expect(file.truncated).toBe(false);
    expect(file.content).toBe(
      '日期,营业额,商品支付金额,商品退款金额,运费收入,支付订单数\n' +
        '2026-02-01,300.00,290.00,0.00,10.00,2\n' +
        '2026-02-02,5.00,45.00,45.00,5.00,1\n' +
        '2026-02-03,200.00,300.00,100.00,0.00,1\n',
    );
  });

  it('writes a day that refunded more than it took as a number, not as text', async () => {
    // O6 was paid before the window; refunding 100.00 of it on the 2nd takes
    // that day below zero. The formula guard is for text: `'-95.00` would sum
    // as nothing in a spreadsheet.
    await refund('r4', {
      order: 'o6',
      user: 'u2',
      item: 'o6',
      quantity: 1,
      amount: '100.00',
      succeededAt: '2026-02-02T10:00:00+08:00',
    });
    const file = await stats.tradeExport(harness.ctx, WINDOW);
    expect(file.content.split('\n')[2]).toBe('2026-02-02,-95.00,45.00,145.00,5.00,1');
  });

  it('refuses a time series that does not fit the cap rather than truncating it', async () => {
    await harness.ctx.config.set(statsConfig, { exportMaxRows: 10 });
    // The default window is the last 30 Shanghai days: 30 buckets, 10 allowed.
    await expect(stats.tradeExport(harness.ctx, {})).rejects.toMatchObject({
      code: 'STATS_EXPORT_TOO_LARGE',
      details: { maxRows: 10, matched: 30 },
    });
  });

  it('exports the whole ranking, not the page the operator was looking at', async () => {
    const file = await stats.productExport(harness.ctx, {
      ...WINDOW,
      sortBy: 'paidAmount',
      limit: 1,
    });

    expect(file.filename).toBe('商品统计-2026-02-01至2026-02-03.csv');
    // `limit: 1` sizes the table on screen; the file has both products.
    expect(file.rowCount).toBe(2);
    expect(file.truncated).toBe(false);
    expect(file.content.split('\n')[1]).toBe(`${productIds.p2},手冲壶,2,2,0,4,4,500.00,1,100.00`);
  });

  it('flags a ranking cut short by the cap', async () => {
    // Eleven more products, each with a single view inside the window, so the
    // ranking has thirteen rows and the cap allows ten.
    for (let index = 0; index < 11; index += 1) {
      const [product] = await harness.ctx.db
        .insert(products)
        .values({
          name: `批量商品${index}`,
          imageUrl: '/uploads/bulk.png',
          status: 'on_shelf',
          price: '1.00',
          freightMode: 'free',
        })
        .returning({ id: products.id });
      await harness.ctx.db.insert(productEvents).values({
        productId: product!.id,
        userId: userIds.u1!,
        kind: 'view',
        quantity: 1,
        createdAt: at('2026-02-02T12:00:00+08:00'),
      });
    }

    await harness.ctx.config.set(statsConfig, { exportMaxRows: 10 });
    const file = await stats.productExport(harness.ctx, {
      ...WINDOW,
      sortBy: 'paidAmount',
      limit: 20,
    });
    expect(file.rowCount).toBe(10);
    expect(file.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// window, cache and the home page
// ---------------------------------------------------------------------------

describe('window handling', () => {
  it('buckets a single day by the hour', async () => {
    const page = await stats.tradeStats(harness.ctx, {
      from: '2026-02-01T00:00:00+08:00',
      to: '2026-02-01T23:59:59+08:00',
    });
    expect(page.chart.bucket).toBe('hour');
    expect(page.chart.buckets).toHaveLength(24);
    // O1 at 10:00 and O2 at 23:30, Shanghai.
    expect(line(page, '商品支付金额')[10]).toBe(90);
    expect(line(page, '商品支付金额')[23]).toBe(200);
  });

  it('refuses an impossible window', async () => {
    await expect(
      stats.tradeStats(harness.ctx, {
        from: '2026-02-05T00:00:00+08:00',
        to: '2026-02-01T00:00:00+08:00',
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('answers an empty window with zeros rather than nothing', async () => {
    const page = await stats.tradeStats(harness.ctx, {
      from: '2025-06-01T00:00:00+08:00',
      to: '2025-06-03T23:59:59+08:00',
    });
    expect(tile(page, 'revenue').value).toBe(0);
    expect(tile(page, 'paidOrderCount').value).toBe(0);
    expect(line(page, '营业额')).toEqual([0, 0, 0]);
  });
});

describe('cache', () => {
  it('serves a block from Redis for its window and lets it be cleared', async () => {
    const first = await stats.tradeStats(harness.ctx, WINDOW);
    expect(tile(first, 'paidOrderCount').value).toBe(4);

    await order('o7', {
      user: 'u1',
      platform: 'h5',
      kind: 'normal',
      createdAt: '2026-02-03T10:00:00+08:00',
      paidAt: '2026-02-03T10:30:00+08:00',
      paidAmount: '77.00',
      freight: '0.00',
      province: '浙江',
      lines: [{ key: 'p1', quantity: 1, total: '77.00' }],
    });

    const cachedAnswer = await stats.tradeStats(harness.ctx, WINDOW);
    expect(tile(cachedAnswer, 'paidOrderCount').value).toBe(4);

    await clearStatsCache(harness.ctx);
    const fresh = await stats.tradeStats(harness.ctx, WINDOW);
    expect(tile(fresh, 'paidOrderCount').value).toBe(5);
  });

  it('computes every time when the shop turns caching off', async () => {
    await harness.ctx.config.set(statsConfig, { cacheSeconds: 0 });
    await stats.tradeStats(harness.ctx, WINDOW);

    await order('o8', {
      user: 'u1',
      platform: 'h5',
      kind: 'normal',
      createdAt: '2026-02-03T10:00:00+08:00',
      paidAt: '2026-02-03T10:30:00+08:00',
      paidAmount: '77.00',
      freight: '0.00',
      province: '浙江',
      lines: [{ key: 'p1', quantity: 1, total: '77.00' }],
    });

    const page = await stats.tradeStats(harness.ctx, WINDOW);
    expect(tile(page, 'paidOrderCount').value).toBe(5);
  });
});

describe('dashboard tiles', () => {
  it('reads today and yesterday in Shanghai days', async () => {
    const today = await stats.todayFigures(harness.ctx);
    // Nothing was paid on the 4th; the 3rd took 300.00 and gave 100.00 back.
    expect(today.revenue).toBe(0);
    expect(today.paidOrderCount).toBe(0);
    expect(today.previous).toEqual({ revenue: 200, paidOrderCount: 1, newUsers: 0 });
  });
});
