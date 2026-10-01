import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ShippingTemplateForm } from '@shop/contracts/shipping/schemas';
import { products, productSkus } from '@shop/db/schema/catalog';
import { presaleActivities } from '@shop/db/schema/presale';
import { cities, expressCompanies } from '@shop/db/schema/reference';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { DomainError } from '../kernel/errors';
import { orderConfig } from '../order';
import { logisticsConfig } from '../system';
import * as express from './shipping.express.service';
import * as templates from './shipping.template.service';
import { cityTree, resetCityTreeCache } from './shipping.city.service';
import { freightPort } from './shipping.freight.port';
import { logisticsPort, resetTrackingFetch, setTrackingFetch } from './shipping.logistics.port';

/**
 * The shipping domain against a real PostgreSQL 17.
 *
 * The freight *arithmetic* is covered next door in
 * `shipping.freight.rules.test.ts`, which needs no database. What is proven
 * here is everything the algorithm depends on the database for: the region and
 * free-rule rows round-trip, the address's division is expanded into its
 * ancestors, the fallback rule's partial unique index holds, a template in use
 * cannot be deleted, and the city tree's version changes with the data.
 */

let harness: TestCtx;

beforeAll(async () => {
  // Kept for the template-in-use checks, which count the products pointing at a
  // template. The freight port itself does not need the catalog registered: the
  // line carries its own `freightMode`, so the port never re-reads skus.
  registerCatalogDomain();
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  resetCityTreeCache();
  await seedCities();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 浙江 → 杭州市 → 西湖区, plus 北京 for the "somewhere else" cases. */
async function seedCities(): Promise<void> {
  await harness.ctx.db.insert(cities).values([
    { id: 330000, parentId: null, level: 0, name: '浙江' },
    { id: 330100, parentId: 330000, level: 1, name: '杭州市' },
    { id: 330106, parentId: 330100, level: 2, name: '西湖区' },
    { id: 110000, parentId: null, level: 0, name: '北京' },
    { id: 110100, parentId: 110000, level: 1, name: '北京市' },
    { id: 110101, parentId: 110100, level: 2, name: '东城区' },
  ]);
}

let sequence = 0;

function form(overrides: Partial<ShippingTemplateForm> = {}): ShippingTemplateForm {
  sequence += 1;
  return {
    name: `模板${sequence}`,
    chargeMode: 'quantity',
    hasFreeRules: false,
    hasNoDeliveryRules: false,
    sortOrder: 0,
    regions: [
      {
        isFallback: true,
        cityIds: [],
        firstUnit: 1,
        firstPrice: '10.00',
        additionalUnit: 1,
        additionalPrice: '5.00',
      },
    ],
    freeRules: [],
    noDeliveryCityIds: [],
    ...overrides,
  };
}

/** A product + one sku, quoted through the `FreightPort` like checkout does. */
async function makeSku(options: {
  freightMode: 'free' | 'fixed' | 'template';
  fixedFreight?: string;
  templateId?: string;
  weight?: string;
  volume?: string;
}): Promise<number> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      imageUrl: 'https://example.test/p.png',
      status: 'on_shelf',
      price: '100.00',
      freightMode: options.freightMode,
      fixedFreight: options.fixedFreight ?? null,
      shippingTemplateId: options.templateId === undefined ? null : Number(options.templateId),
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      price: '100.00',
      stock: 100,
      isDefault: true,
      weight: options.weight ?? null,
      volume: options.volume ?? null,
    })
    .returning({ id: productSkus.id });
  return sku!.id;
}

/**
 * A `FreightLine` as checkout hands one over.
 *
 * `freightMode` and `fixedFreightFen` travel **with** the line: the port does
 * not re-read the sku to learn how it is charged, so a test that writes
 * `freightMode: 'fixed'` onto the product has to say so here too — exactly as
 * `order.pricing.ts` does, from the `SkuForSale` it already holds.
 */
function quoteLine(skuId: number, overrides: Record<string, unknown> = {}) {
  return {
    skuId,
    quantity: 1,
    freightMode: 'template' as const,
    fixedFreightFen: 0,
    freightTemplateId: null,
    weight: 0,
    volume: 0,
    amountFen: 10000,
    ...overrides,
  };
}

/** The same, for a product charged a flat postage per unit. */
function fixedLine(
  skuId: number,
  fixedFreightFen: number,
  overrides: Record<string, unknown> = {},
) {
  return quoteLine(skuId, { freightMode: 'fixed', fixedFreightFen, ...overrides });
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

describe('运费模板', () => {
  it('round-trips a template with regions, free rules and a no-delivery list', async () => {
    const created = await templates.create(
      harness.ctx,
      form({
        chargeMode: 'weight',
        hasFreeRules: true,
        hasNoDeliveryRules: true,
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '12.00',
            additionalUnit: 1,
            additionalPrice: '6.00',
          },
          {
            isFallback: false,
            cityIds: ['330100'],
            firstUnit: 2,
            firstPrice: '6.00',
            additionalUnit: 1,
            additionalPrice: '2.00',
          },
        ],
        freeRules: [{ cityIds: ['330000'], minUnits: 5, minAmount: '199.00' }],
        noDeliveryCityIds: ['110000'],
      }),
    );

    const detail = await templates.detail(harness.ctx, { id: created.id });
    expect(detail.chargeMode).toBe('weight');
    expect(detail.regions).toHaveLength(2);
    expect(detail.regions[0]?.isFallback).toBe(true);
    expect(detail.regions[1]?.cityIds).toEqual(['330100']);
    expect(detail.regions[1]?.firstUnit).toBe(2);
    expect(detail.freeRules).toEqual([{ cityIds: ['330000'], minUnits: 5, minAmount: '199.00' }]);
    expect(detail.noDeliveryCityIds).toEqual(['110000']);
    expect(detail.productCount).toBe(0);
  });

  it('replaces every child row on update rather than accumulating them', async () => {
    const created = await templates.create(harness.ctx, form());
    await templates.update(
      harness.ctx,
      { id: created.id },
      form({
        name: '改过的模板',
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 3,
            firstPrice: '3.00',
            additionalUnit: 0,
            additionalPrice: '0.00',
          },
        ],
      }),
    );
    const detail = await templates.detail(harness.ctx, { id: created.id });
    expect(detail.name).toBe('改过的模板');
    expect(detail.regions).toHaveLength(1);
    expect(detail.regions[0]?.firstPrice).toBe('3.00');
  });

  it('refuses a city id the tree does not have', async () => {
    const error = await templates
      .create(
        harness.ctx,
        form({
          regions: [
            {
              isFallback: false,
              cityIds: ['999999'],
              firstUnit: 1,
              firstPrice: '1.00',
              additionalUnit: 0,
              additionalPrice: '0.00',
            },
            {
              isFallback: true,
              cityIds: [],
              firstUnit: 1,
              firstPrice: '1.00',
              additionalUnit: 0,
              additionalPrice: '0.00',
            },
          ],
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('SHIPPING_CITY_UNKNOWN');
  });

  it('refuses to delete a template a product still points at', async () => {
    const created = await templates.create(harness.ctx, form());
    await makeSku({ freightMode: 'template', templateId: created.id });

    const error = await templates.remove(harness.ctx, { id: created.id }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('SHIPPING_TEMPLATE_IN_USE');

    const list = await templates.list(harness.ctx, { page: 1, pageSize: 20 });
    expect(list.items[0]?.productCount).toBe(1);
  });

  it('refuses to delete a template a live presale still charges by, and lets an ended one go', async () => {
    const created = await templates.create(harness.ctx, form());
    const skuId = await makeSku({ freightMode: 'free' });
    const [sku] = await harness.ctx.db.select().from(productSkus).where(eq(productSkus.id, skuId));
    const [activity] = await harness.ctx.db
      .insert(presaleActivities)
      .values({
        productId: sku!.productId,
        title: '预售',
        status: 'active',
        price: '80.00',
        startAt: new Date('2026-01-01T00:00:00Z'),
        endAt: new Date('2027-01-01T00:00:00Z'),
        shippingTemplateId: Number(created.id),
      })
      .returning({ id: presaleActivities.id });

    // The delete is soft, so no foreign key stops it: without the count the
    // campaign would quietly start charging no freight.
    await expect(templates.remove(harness.ctx, { id: created.id })).rejects.toMatchObject({
      code: 'SHIPPING_TEMPLATE_IN_USE',
      details: { productCount: 0, activityCount: 1 },
    });

    await harness.ctx.db
      .update(presaleActivities)
      .set({ status: 'ended' })
      .where(eq(presaleActivities.id, activity!.id));
    expect(await templates.remove(harness.ctx, { id: created.id })).toEqual({ deleted: true });
  });

  it('soft-deletes an unused template and drops it from the list', async () => {
    const created = await templates.create(harness.ctx, form());
    expect(await templates.remove(harness.ctx, { id: created.id })).toEqual({ deleted: true });
    const list = await templates.list(harness.ctx, { page: 1, pageSize: 20 });
    expect(list.total).toBe(0);
    await expect(templates.detail(harness.ctx, { id: created.id })).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

describe('FreightPort.quote', () => {
  it('charges a fixed postage per unit', async () => {
    const skuId = await makeSku({ freightMode: 'fixed', fixedFreight: '8.00' });
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [fixedLine(skuId, 800, { quantity: 3 })],
    });
    expect(quote.totalFen).toBe(2400);
    expect(quote.perLine).toEqual([2400]);
  });

  it('prices a template line through the city rule that covers the address', async () => {
    const template = await templates.create(
      harness.ctx,
      form({
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '20.00',
            additionalUnit: 1,
            additionalPrice: '10.00',
          },
          {
            isFallback: false,
            cityIds: ['330100'],
            firstUnit: 2,
            firstPrice: '6.00',
            additionalUnit: 1,
            additionalPrice: '2.00',
          },
        ],
      }),
    );
    const skuId = await makeSku({ freightMode: 'template', templateId: template.id });

    // 西湖区's parent is 杭州市, which the rule names: ¥6 for the first 2 + ¥2.
    const hangzhou = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [quoteLine(skuId, { quantity: 3, freightTemplateId: Number(template.id) })],
    });
    expect(hangzhou.totalFen).toBe(800);

    // 北京 matches no rule, so the fallback applies: ¥20 + 2 × ¥10.
    const beijing = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 110101,
      lines: [quoteLine(skuId, { quantity: 3, freightTemplateId: Number(template.id) })],
    });
    expect(beijing.totalFen).toBe(4000);
  });

  it('prices an address with no known division at the fallback region, not free', async () => {
    const template = await templates.create(
      harness.ctx,
      form({
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '20.00',
            additionalUnit: 1,
            additionalPrice: '10.00',
          },
          {
            isFallback: false,
            cityIds: ['330100'],
            firstUnit: 2,
            firstPrice: '6.00',
            additionalUnit: 1,
            additionalPrice: '2.00',
          },
        ],
      }),
    );
    const skuId = await makeSku({ freightMode: 'template', templateId: template.id });
    const lines = [quoteLine(skuId, { quantity: 3, freightTemplateId: Number(template.id) })];

    // An address with no division (`city_id` NULL) and one naming a division
    // the city table does not have: both are priced like a province the
    // template does not list — ¥20 + 2 × ¥10.
    const noCity = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: null,
      lines,
    });
    expect(noCity).toEqual({ totalFen: 4000, perLine: [4000] });

    const unknownCity = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 999_999_999,
      lines,
    });
    expect(unknownCity.totalFen).toBe(4000);
  });

  it('charges by weight when the template says so', async () => {
    const template = await templates.create(
      harness.ctx,
      form({
        chargeMode: 'weight',
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '10.00',
            additionalUnit: 1,
            additionalPrice: '5.00',
          },
        ],
      }),
    );
    const skuId = await makeSku({
      freightMode: 'template',
      templateId: template.id,
      weight: '1.500',
    });
    // 2 × 1.5 kg = 3 kg: first kilo ¥10, two more at ¥5.
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [
        quoteLine(skuId, {
          quantity: 2,
          weight: 3000,
          freightTemplateId: Number(template.id),
        }),
      ],
    });
    expect(quote.totalFen).toBe(2000);
  });

  it('drops the group once its free rule is satisfied', async () => {
    const template = await templates.create(
      harness.ctx,
      form({
        hasFreeRules: true,
        freeRules: [{ cityIds: ['330000'], minUnits: 2, minAmount: null }],
      }),
    );
    const skuId = await makeSku({ freightMode: 'template', templateId: template.id });
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [quoteLine(skuId, { quantity: 2, freightTemplateId: Number(template.id) })],
    });
    expect(quote.totalFen).toBe(0);
  });

  it('refuses an address the template will not deliver to', async () => {
    const template = await templates.create(
      harness.ctx,
      form({ hasNoDeliveryRules: true, noDeliveryCityIds: ['110000'] }),
    );
    const skuId = await makeSku({ freightMode: 'template', templateId: template.id });
    const error = await freightPort
      .quote(harness.ctx.db, harness.ctx, {
        addressCityId: 110101,
        lines: [quoteLine(skuId, { freightTemplateId: Number(template.id) })],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('SHIPPING_NOT_DELIVERABLE');
  });

  /**
   * 满额包邮 is settled here and nowhere else. Checkout cannot do it: by the
   * time it knows the goods total it has already been handed a per-line quote,
   * and a fixed-postage line is the case that proves the difference — charging
   * it regardless of the threshold is the bug an operator reports as
   * 「满额包邮不生效」.
   *
   * The setting is in 元 and everything else here is 分, so the boundary is
   * worth pinning from both sides rather than only from above.
   */
  // FREIGHT-003 names this test, so the name stays exactly as it is.
  it('zeroes the postage once the shop-wide 满额包邮 threshold is met', async () => {
    await harness.ctx.config.set(orderConfig, { freeShippingThreshold: 99 });
    const skuId = await makeSku({ freightMode: 'fixed', fixedFreight: '8.00' });
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [fixedLine(skuId, 800, { quantity: 1, amountFen: 9900 })],
    });
    expect(quote.totalFen).toBe(0);
    expect(quote.perLine).toEqual([0]);
  });

  it('still charges a fixed postage one fen below the threshold', async () => {
    await harness.ctx.config.set(orderConfig, { freeShippingThreshold: 99 });
    const skuId = await makeSku({ freightMode: 'fixed', fixedFreight: '8.00' });
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [fixedLine(skuId, 800, { quantity: 1, amountFen: 9899 })],
    });
    expect(quote.totalFen).toBe(800);
  });

  it('zeroes a template line too, and prorates nothing across the order', async () => {
    await harness.ctx.config.set(orderConfig, { freeShippingThreshold: 99 });
    const template = await templates.create(
      harness.ctx,
      form({
        chargeMode: 'quantity',
        regions: [
          {
            isFallback: false,
            cityIds: ['330000'],
            firstUnit: 1,
            firstPrice: '12.00',
            additionalUnit: 1,
            additionalPrice: '6.00',
          },
        ],
      }),
    );
    const templateSku = await makeSku({ freightMode: 'template', templateId: template.id });
    const fixedSku = await makeSku({ freightMode: 'fixed', fixedFreight: '8.00' });
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [
        quoteLine(templateSku, { amountFen: 5000, freightTemplateId: Number(template.id) }),
        fixedLine(fixedSku, 800, { amountFen: 4900 }),
      ],
    });
    // 50.00 + 49.00 = 99.00, exactly the threshold: both lines ship free.
    expect(quote.totalFen).toBe(0);
    expect(quote.perLine).toEqual([0, 0]);
  });

  it('leaves the postage alone when 满额包邮 is switched off', async () => {
    await harness.ctx.config.set(orderConfig, { freeShippingThreshold: 0 });
    const skuId = await makeSku({ freightMode: 'fixed', fixedFreight: '8.00' });
    const quote = await freightPort.quote(harness.ctx.db, harness.ctx, {
      addressCityId: 330106,
      lines: [fixedLine(skuId, 800, { quantity: 2, amountFen: 100_000 })],
    });
    expect(quote.totalFen).toBe(1600);
  });
});

// ---------------------------------------------------------------------------
// cities and carriers
// ---------------------------------------------------------------------------

describe('city tree', () => {
  it('nests three levels and fingerprints the data', async () => {
    const tree = await cityTree(harness.ctx);
    // Ordered by level then id, so 北京 (110000) comes before 浙江 (330000).
    expect(tree.items.map((item) => item.name)).toEqual(['北京', '浙江']);
    expect(tree.items[1]?.children[0]?.children[0]?.name).toBe('西湖区');
    expect(tree.version).toBe('cities-6-330106');
  });

  it('rebuilds when the seeded data changes', async () => {
    const before = await cityTree(harness.ctx);
    await harness.ctx.db
      .insert(cities)
      .values({ id: 440000, parentId: null, level: 0, name: '广东' });
    const after = await cityTree(harness.ctx);
    expect(after.version).not.toBe(before.version);
    expect(after.items).toHaveLength(3);
  });
});

describe('快递公司', () => {
  it('lists enabled carriers most-used-first for the picker', async () => {
    await harness.ctx.db.insert(expressCompanies).values([
      { code: 'SF', name: '顺丰速运', sortOrder: 100, isEnabled: true },
      { code: 'ZTO', name: '中通快递', sortOrder: 90, isEnabled: true },
      { code: 'OLD', name: '停用的', sortOrder: 999, isEnabled: false },
    ]);
    const picker = await express.pickerList(harness.ctx);
    expect(picker.items.map((item) => item.code)).toEqual(['SF', 'ZTO']);
  });

  it('SHIP-003 — the shopper’s picker: enabled only, a WeChat courier code first, searched and capped', async () => {
    await harness.ctx.db.insert(expressCompanies).values([
      { code: 'shunfeng', name: '顺丰速运', sortOrder: 100, wechatDeliveryId: 'SF' },
      { code: 'shunfengkuaiyun', name: '顺丰快运', sortOrder: 200 },
      { code: 'zhongtong', name: '中通快递', sortOrder: 90, wechatDeliveryId: 'ZTO' },
      { code: 'yuantong', name: '圆通速递', sortOrder: 300 },
      { code: 'old_sf', name: '顺丰旧线', sortOrder: 999, isEnabled: false },
      { code: 'pct_100', name: '百分之百快递', sortOrder: 1 },
    ]);
    const codes = async (query: { keyword?: string; limit?: number }) =>
      (await express.shopperOptions(harness.ctx, { limit: 50, ...query })).items.map(
        (item) => item.code,
      );

    // No parameters: every enabled carrier, those WeChat knows first, then the most used.
    expect(await codes({})).toEqual([
      'shunfeng',
      'zhongtong',
      'yuantong',
      'shunfengkuaiyun',
      'pct_100',
    ]);
    expect(await codes({ limit: 2 })).toEqual(['shunfeng', 'zhongtong']);
    // By name or by code, case-insensitively; a disabled carrier is never offered.
    expect(await codes({ keyword: '顺丰' })).toEqual(['shunfeng', 'shunfengkuaiyun']);
    expect(await codes({ keyword: 'ZhongTong' })).toEqual(['zhongtong']);
    // `%` and `_` are what the shopper typed, not wildcards.
    expect(await codes({ keyword: '_' })).toEqual(['pct_100']);
    expect(await codes({ keyword: '%' })).toEqual([]);
    // The operators' pickers stay whole and in their own order.
    expect((await express.pickerList(harness.ctx)).items.map((item) => item.code)).toEqual([
      'yuantong',
      'shunfengkuaiyun',
      'shunfeng',
      'zhongtong',
      'pct_100',
    ]);
  });

  it('refuses a duplicate code', async () => {
    await express.adminCreate(harness.ctx, {
      code: 'SF',
      name: '顺丰速运',
      sortOrder: 0,
      isEnabled: true,
    });
    const error = await express
      .adminCreate(harness.ctx, { code: 'SF', name: '又一个顺丰', sortOrder: 0, isEnabled: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('SHIPPING_EXPRESS_COMPANY_CODE_TAKEN');
  });

  it('disables a carrier without deleting it, and the picker stops offering it', async () => {
    const created = await express.adminCreate(harness.ctx, {
      code: 'YTO',
      name: '圆通速递',
      sortOrder: 10,
      isEnabled: true,
    });
    await express.adminSetStatus(harness.ctx, { id: created.id }, { isEnabled: false });
    expect((await express.pickerList(harness.ctx)).items).toEqual([]);
    const list = await express.adminList(harness.ctx, { page: 1, pageSize: 20 });
    expect(list.items[0]?.isEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tracking
// ---------------------------------------------------------------------------

describe('LogisticsPort.track', () => {
  afterEach(() => {
    resetTrackingFetch();
  });

  const payload = {
    status: '0',
    result: {
      deliverystatus: '3',
      list: [{ time: '2026-06-01 09:00:00', status: '已签收' }],
    },
  };

  function fakeFetch(calls: { url: string; init: RequestInit }[]) {
    return async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  it('answers unknown while no provider is configured — never an exception', async () => {
    const result = await logisticsPort.track(harness.ctx, { companyCode: 'SF', trackingNo: 'SF1' });
    expect(result).toEqual({ state: 'unknown', traces: [] });
  });

  it('offers 阿里云云市场 as the only provider', async () => {
    // The setting is gone, not merely unimplemented: a value the driver cannot
    // serve must not be selectable, or the form promises tracking it will never
    // deliver. The stored group refuses it too, so an imported or hand-edited
    // row cannot put the shop back into that state.
    await expect(
      harness.ctx.config.set(logisticsConfig, {
        provider: 'kuaidi100' as never,
        appCode: 'x',
      }),
    ).rejects.toThrow();
    expect(logisticsConfig.schema.shape.provider.safeParse('kuaidi100').success).toBe(false);
    expect(logisticsConfig.schema.shape.provider.safeParse('aliyun-market').success).toBe(true);
    expect(Object.keys(logisticsConfig.schema.shape)).not.toContain('customer');
  });

  it('calls the market API once and serves the second look-up from Redis', async () => {
    await harness.ctx.config.set(logisticsConfig, {
      provider: 'aliyun-market',
      appCode: 'test-code',
      cacheMinutes: 30,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    setTrackingFetch(fakeFetch(calls));

    const first = await logisticsPort.track(harness.ctx, {
      companyCode: 'shunfeng',
      trackingNo: 'SF1',
      phone: '13800001234',
    });
    const second = await logisticsPort.track(harness.ctx, {
      companyCode: 'shunfeng',
      trackingNo: 'SF1',
      phone: '13800001234',
    });

    expect(first.state).toBe('delivered');
    expect(first.traces[0]?.context).toBe('已签收');
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    // The credential travels in the header, the phone's last four digits in the
    // number, and the host is the hardcoded one.
    expect(calls[0]?.url).toContain('https://wuliu.market.alicloudapi.com/kdi?');
    expect(calls[0]?.url).toContain('SF1%3A1234');
    expect(calls[0]?.url).toContain('type=SFEXPRESS');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'APPCODE test-code',
    );
  });

  it('answers unknown when the vendor refuses the credential', async () => {
    await harness.ctx.config.set(logisticsConfig, {
      provider: 'aliyun-market',
      appCode: 'bad',
      cacheMinutes: 30,
    });
    setTrackingFetch(async () => new Response('nope', { status: 403 }));
    const result = await logisticsPort.track(harness.ctx, {
      companyCode: 'SF',
      trackingNo: 'SF-403',
    });
    expect(result).toEqual({ state: 'unknown', traces: [] });
  });
});
