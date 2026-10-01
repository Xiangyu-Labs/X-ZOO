import { readFile } from 'node:fs/promises';

import { adminProductCreate } from '@shop/core/catalog';
import { sql } from 'drizzle-orm';
import type { Page } from '@playwright/test';

import { test, expect } from '../src/fixtures';
import { makePaidOrder } from '../src/seed';
import { stack, type Stack } from '../src/stack';

/**
 * 统计 — the figures on the screen are the definitions in
 * `packages/core/src/stats/DEFINITIONS.md`, computed here independently from
 * the same tables, and the product export is a file Excel can open safely.
 *
 * The expected numbers are recomputed with SQL written in this file rather
 * than asserted as constants, because every other spec in the run pays for,
 * ships or refunds orders in the same database; what is being proven is the
 * *definition* (营业额 = Σ paid − Σ succeeded refunds in the window), and that
 * the trade page and the order page agree on the money that came in.
 *
 * The window is the pages' default: the last 30 Shanghai days, today included.
 */

const serial = Date.now() % 1_000_000_000;
const FORMULA_NAME = `=1+1 E2E 公式商品 ${serial}`;

/** `¥1,234.00`, exactly as the tiles format money. */
function yuan(value: number): string {
  const [whole, cents] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}¥${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

const WINDOW = sql`
  ((date_trunc('day', now() at time zone 'Asia/Shanghai') - interval '29 days') at time zone 'Asia/Shanghai')`;
const WINDOW_END = sql`
  ((date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '1 day') at time zone 'Asia/Shanghai')`;

async function expected(shop: Stack): Promise<{ paid: number; count: number; refunded: number }> {
  const paid = await shop.db.execute<{ paid: string; count: number }>(sql`
    select coalesce(sum(paid_amount), 0)::text as paid, count(*)::int as count
    from orders
    where paid_at is not null and deleted_at is null
      and paid_at >= ${WINDOW} and paid_at < ${WINDOW_END}`);
  const refunded = await shop.db.execute<{ refunded: string }>(sql`
    select coalesce(sum(refunded_amount), 0)::text as refunded
    from refunds
    where status = 'succeeded' and deleted_at is null
      and succeeded_at >= ${WINDOW} and succeeded_at < ${WINDOW_END}`);
  return {
    paid: Number(paid.rows[0]!.paid),
    count: paid.rows[0]!.count,
    refunded: Number(refunded.rows[0]!.refunded),
  };
}

/** Stats are cached for a minute in Redis; a spec that just arranged an order must not read a stale tile. */
async function dropStatsCache(shop: Stack): Promise<void> {
  const keys = await shop.redis.keys('stats:*');
  if (keys.length > 0) await shop.redis.del(...keys);
}

/**
 * One tile's figure, exactly: the label, then the value, then the 环比 line
 * (or its "—"). Anchored, so ¥297.00 cannot pass for ¥1,297.00 and 5 orders
 * cannot pass for 15.
 */
async function expectFigure(page: Page, label: string, value: string): Promise<void> {
  const tile = page
    .locator('.ant-card')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(tile).toHaveText(new RegExp(`^${label}\\s*${escaped}\\s*(环比|—)`));
}

test.beforeAll(async () => {
  // A product whose name is a spreadsheet formula, paid for once, so it is on
  // the ranking and therefore in the export.
  const shop = await stack();
  const product = await adminProductCreate(shop.ctx, {
    name: FORMULA_NAME,
    sliderImages: [],
    kind: 'physical',
    status: 'on_shelf',
    // A 1×1 PNG inline: the ranking renders the image, and it must not reach for a host.
    imageUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    displaySalesBoost: 0,
    specMode: false,
    specs: [],
    skus: [
      {
        specValues: {},
        price: '99.00',
        stock: 10,
        isDefault: true,
        isVisible: true,
        sortOrder: 0,
      },
    ],
    freightMode: 'free',
    purchaseLimitMode: 'none',
    minPurchaseQuantity: 1,
    isHot: false,
    isNew: false,
    isBest: false,
    isBenefit: false,
    isRecommended: false,
    sortOrder: 0,
    descriptionHtml: '',
    categoryIds: [String(shop.fixtures.categoryId)],
    labelIds: [],
    protectionIds: [],
    params: [],
    recommendedProductIds: [],
    giftCouponIds: [],
  });
  const productId = Number(product.id);
  const skus = await shop.db.execute<{ id: number }>(
    sql`select id from product_skus where product_id = ${productId} limit 1`,
  );
  const sku = skus.rows[0];
  await makePaidOrder(shop, {
    userId: shop.fixtures.userId!,
    productId,
    skuId: sku!.id,
    no: `E2S${serial}`,
  });
  await dropStatsCache(shop);
});

test('营业额 and 支付订单数 are the definitions, and the order page agrees on the money', async ({
  adminPage,
  shop,
}) => {
  const { paid, count, refunded } = await expected(shop);
  expect(count, 'the seed and this spec each paid at least one order').toBeGreaterThan(0);

  await adminPage.goto('/admin/stats/trade');
  await expectFigure(adminPage, '营业额', yuan(paid - refunded));
  await expectFigure(adminPage, '支付订单数', String(count));
  await expectFigure(
    adminPage,
    '客单价',
    yuan(Math.round(((paid - refunded) / count) * 100) / 100),
  );

  // 订单销售额 is Σ paid_amount (no refunds subtracted): the same money, from
  // another page, by the same definition.
  await adminPage.goto('/admin/stats/orders');
  await expectFigure(adminPage, '订单销售额', yuan(paid));
  await expectFigure(adminPage, '订单量', String(count));
});

test('the product export is a BOM-prefixed CSV whose formula-looking name is defused', async ({
  adminPage,
}) => {
  await adminPage.goto('/admin/stats/products');
  const [download] = await Promise.all([
    adminPage.waitForEvent('download'),
    adminPage.getByRole('button', { name: /导出商品统计/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^商品统计-\d{4}-\d{2}-\d{2}(至\d{4}-\d{2}-\d{2})?\.csv$/,
  );

  const bytes = await readFile(await download.path());
  // The BOM, so Excel on Windows reads UTF-8 rather than GBK.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString('utf8');
  const [header, ...rows] = text.trimEnd().split('\n');
  expect(header).toBe(
    '商品ID,商品名称,浏览量,访客数,加购件数,下单件数,支付件数,支付金额,收藏数,访问-支付转化率',
  );

  const line = rows.find((row) => row.includes(`E2E 公式商品 ${serial}`));
  expect(line, 'the paid-for product is in the export').toBeDefined();
  const cells = line!.split(',');
  // A leading `'` makes the spreadsheet treat it as text, not `=1+1`.
  expect(cells[1]).toBe(`'${FORMULA_NAME}`);
  expect(cells[6]).toBe('1');
  expect(cells[7]).toBe('99.00');
});
