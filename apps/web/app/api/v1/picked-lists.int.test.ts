import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  productCategories,
  productCategoriesMap,
  productLabelCategories,
  productLabels,
  productLabelsMap,
  products,
} from '@shop/db/schema/catalog';
import { articleCategories, articles } from '@shop/db/schema/cms';
import { couponTemplates } from '@shop/db/schema/coupon';
import { groupbuyActivities } from '@shop/db/schema/groupbuy';
import { presaleActivities } from '@shop/db/schema/presale';
import { AdminAuthService, UserSessionService } from '@shop/core/auth';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The storefront lists a DIY component reads when the operator picked its
 * records (指定数据): `/api/v1/articles`, `/api/v1/coupons`,
 * `/api/v1/catalog/products`, `/api/v1/groupbuy/activities` and
 * `/api/v1/presale/activities`, each with `ids`.
 *
 * Three promises per list, and all three are only visible over HTTP:
 *
 *  - the rows come back in the order of `ids`, not in the list's own order —
 *    the operator arranged them;
 *  - an id the shopper can no longer see is skipped, not an error — the page
 *    was saved before the record went away, and one stale pick must not blank
 *    the whole component;
 *  - more than 100 ids is a `422`, from the contract, before any query runs.
 *
 * The container runs with `VALIDATE_RESPONSES` on, so every answer is also
 * checked against its contract.
 */

let harness: TestCtx;

const ORIGIN = 'https://shop.example';

const env: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'unused',
  REDIS_URL: 'unused',
  UPLOADS_DIR: '/tmp/uploads',
  UPLOADS_PUBLIC_PREFIX: '/uploads',
  APP_ORIGIN: ORIGIN,
  EXTRA_ALLOWED_ORIGINS: [],
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  VALIDATE_RESPONSES: true,
  DB_POOL_MAX: 5,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z', platform: 'h5' });
  const container: Container = {
    env,
    dbHandle: harness.db.handle,
    db: harness.ctx.db,
    redis: harness.redis,
    clock: harness.clock,
    logger: harness.ctx.logger,
    queue: harness.ctx.queue,
    storage: harness.ctx.storage,
    config: harness.ctx.config,
    adminAuth: new AdminAuthService(harness.ctx, { bcryptCost: 4 }),
    userSessions: new UserSessionService(),
    close: async () => {},
  };
  setContainer(container);
}, 180_000);

afterAll(async () => {
  setContainer(undefined);
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const get = (path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { 'x-client-platform': 'h5' } });

/** `?ids=` with 101 distinct ids — one past the cap. */
const tooMany = Array.from({ length: 101 }, (_unused, i) => String(i + 1)).join(',');

async function idsOf(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: { id?: string; templateId?: string; activityId?: string }[];
  };
  return body.items.map((item) => String(item.templateId ?? item.activityId ?? item.id));
}

let sequence = 0;

async function article(values: Partial<typeof articles.$inferInsert> = {}): Promise<string> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(articles)
    .values({
      title: `文章${sequence}`,
      status: 'published',
      publishedAt: new Date('2026-05-01T00:00:00.000Z'),
      ...values,
    })
    .returning({ id: articles.id });
  return String(row!.id);
}

async function articleCategory(title: string): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(articleCategories)
    .values({ title })
    .returning({ id: articleCategories.id });
  return row!.id;
}

/** A template a shopper may claim by hand today, unless `values` says otherwise. */
async function template(
  values: Partial<typeof couponTemplates.$inferInsert> = {},
): Promise<string> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name: `券${sequence}`,
      scope: 'all_products',
      claimMode: 'manual',
      status: 'active',
      discountAmount: '10.00',
      minSpend: '100.00',
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: false,
      totalCount: 100,
      remainingCount: 100,
      perUserLimit: 1,
      ...values,
    })
    .returning({ id: couponTemplates.id });
  return String(row!.id);
}

async function productCategory(name: string): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(productCategories)
    .values({ name, path: '/', level: 0 })
    .returning({ id: productCategories.id });
  return row!.id;
}

async function productLabel(name: string): Promise<number> {
  const [group] = await harness.ctx.db
    .insert(productLabelCategories)
    .values({ name: `${name}组` })
    .returning({ id: productLabelCategories.id });
  const [row] = await harness.ctx.db
    .insert(productLabels)
    .values({ categoryId: group!.id, name, isEnabled: true })
    .returning({ id: productLabels.id });
  return row!.id;
}

async function product(
  values: Partial<typeof products.$inferInsert> = {},
  links: { categoryId?: number; labelId?: number } = {},
): Promise<string> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 50,
      freightMode: 'free',
      unitName: '件',
      ...values,
    })
    .returning({ id: products.id });
  if (links.categoryId !== undefined) {
    await harness.ctx.db
      .insert(productCategoriesMap)
      .values({ productId: row!.id, categoryId: links.categoryId });
  }
  if (links.labelId !== undefined) {
    await harness.ctx.db
      .insert(productLabelsMap)
      .values({ productId: row!.id, labelId: links.labelId });
  }
  return String(row!.id);
}

// ---------------------------------------------------------------------------
// GET /api/v1/articles
// ---------------------------------------------------------------------------

describe('GET /api/v1/articles?ids=', () => {
  it('answers the picked articles in the order picked, skipping the unpublished', async () => {
    const first = await article({ sortOrder: 1 });
    const draft = await article({ status: 'draft' });
    const hidden = await article({ status: 'hidden' });
    const deleted = await article({ deletedAt: new Date('2026-05-01T00:00:00.000Z') });
    const last = await article({ sortOrder: 9 });
    await article({ sortOrder: 5 }); // published, not picked

    const { GET } = await import('./articles/route');
    const picked = [first, draft, hidden, deleted, last];
    const response = await GET(get(`/api/v1/articles?pageSize=5&ids=${picked.join(',')}`));
    expect(await idsOf(response)).toEqual([first, last]);

    // The list's own order is `sortOrder DESC`; `ids` overrides it both ways.
    const reversed = await GET(get(`/api/v1/articles?ids=${last}&ids=${first}`));
    expect(await idsOf(reversed)).toEqual([last, first]);
  });

  it('filters by any of several categories', async () => {
    const news = await articleCategory('新闻');
    const notice = await articleCategory('公告');
    const other = await articleCategory('其他');
    const inNews = await article({ categoryId: news, sortOrder: 2 });
    const inNotice = await article({ categoryId: notice, sortOrder: 1 });
    await article({ categoryId: other });

    const { GET } = await import('./articles/route');
    const response = await GET(get(`/api/v1/articles?categoryIds=${news},${notice}`));
    expect(await idsOf(response)).toEqual([inNews, inNotice]);
  });

  it('refuses more than 100 ids', async () => {
    const { GET } = await import('./articles/route');
    const response = await GET(get(`/api/v1/articles?ids=${tooMany}`));
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/coupons
// ---------------------------------------------------------------------------

describe('GET /api/v1/coupons?ids=', () => {
  it('answers the picked templates in the order picked, skipping the unclaimable', async () => {
    const first = await template({ sortOrder: 1 });
    const paused = await template({ status: 'disabled' });
    const granted = await template({ claimMode: 'admin_grant' });
    const soldOut = await template({ remainingCount: 0 });
    const closed = await template({ claimTo: new Date('2026-05-01T00:00:00.000Z') });
    const last = await template({ sortOrder: 9 });
    await template({ sortOrder: 5 }); // claimable, not picked

    const { GET } = await import('./coupons/route');
    const picked = [first, paused, granted, soldOut, closed, last];
    const response = await GET(get(`/api/v1/coupons?pageSize=6&ids=${picked.join(',')}`));
    expect(await idsOf(response)).toEqual([first, last]);

    const reversed = await GET(get(`/api/v1/coupons?ids=${last},${first}`));
    expect(await idsOf(reversed)).toEqual([last, first]);
  });

  it('refuses more than 100 ids', async () => {
    const { GET } = await import('./coupons/route');
    const response = await GET(get(`/api/v1/coupons?ids=${tooMany}`));
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/catalog/products
// ---------------------------------------------------------------------------

describe('GET /api/v1/catalog/products?ids=', () => {
  it('answers the picked products in the order picked, skipping the unsellable', async () => {
    const first = await product({ price: '10.00' });
    const offShelf = await product({ status: 'off_shelf' });
    const draft = await product({ status: 'draft' });
    const deleted = await product({ deletedAt: new Date('2026-05-01T00:00:00.000Z') });
    const last = await product({ price: '90.00' });
    await product(); // on shelf, not picked

    const { GET } = await import('./catalog/products/route');
    const picked = [first, offShelf, draft, deleted, last];
    const response = await GET(get(`/api/v1/catalog/products?pageSize=5&ids=${picked.join(',')}`));
    expect(await idsOf(response)).toEqual([first, last]);

    // A sort key does not reorder a picked list.
    const sorted = await GET(
      get(`/api/v1/catalog/products?ids=${last},${first}&sortBy=price&sortOrder=desc`),
    );
    expect(await idsOf(sorted)).toEqual([last, first]);
    const ascending = await GET(
      get(`/api/v1/catalog/products?ids=${last},${first}&sortBy=price&sortOrder=asc`),
    );
    expect(await idsOf(ascending)).toEqual([last, first]);
  });

  it('filters by any of several categories, and by any of several labels', async () => {
    const shirts = await productCategory('T恤');
    const coats = await productCategory('外套');
    const shoes = await productCategory('鞋');
    const hot = await productLabel('爆款');
    const fresh = await productLabel('新品');
    const plain = await productLabel('普通');
    const shirt = await product({ sales: 30 }, { categoryId: shirts, labelId: hot });
    const coat = await product({ sales: 20 }, { categoryId: coats, labelId: fresh });
    await product({ sales: 10 }, { categoryId: shoes, labelId: plain });

    const { GET } = await import('./catalog/products/route');
    const byCategory = await GET(
      get(`/api/v1/catalog/products?categoryIds=${shirts},${coats}&sortBy=sales&sortOrder=desc`),
    );
    expect(await idsOf(byCategory)).toEqual([shirt, coat]);

    const byLabel = await GET(
      get(`/api/v1/catalog/products?labelIds=${fresh}&labelIds=${hot}&sortBy=sales&sortOrder=asc`),
    );
    expect(await idsOf(byLabel)).toEqual([coat, shirt]);
  });

  it('refuses more than 100 ids', async () => {
    const { GET } = await import('./catalog/products/route');
    const response = await GET(get(`/api/v1/catalog/products?ids=${tooMany}`));
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/groupbuy/activities and /api/v1/presale/activities
// ---------------------------------------------------------------------------

const OPEN = new Date('2026-05-01T00:00:00.000Z');
const CLOSE = new Date('2026-07-01T00:00:00.000Z');

async function groupbuyActivity(
  values: Partial<typeof groupbuyActivities.$inferInsert> = {},
): Promise<string> {
  const productId = Number(await product());
  const [row] = await harness.ctx.db
    .insert(groupbuyActivities)
    .values({
      productId,
      title: `拼团${sequence}`,
      status: 'active',
      price: '39.00',
      originalPrice: '60.00',
      seatsRequired: 2,
      groupTtlSeconds: 86_400,
      stock: 10,
      perOrderQuantity: 1,
      startAt: OPEN,
      endAt: CLOSE,
      ...values,
    })
    .returning({ id: groupbuyActivities.id });
  return String(row!.id);
}

async function presaleActivity(
  values: Partial<typeof presaleActivities.$inferInsert> = {},
): Promise<string> {
  const productId = Number(await product());
  const [row] = await harness.ctx.db
    .insert(presaleActivities)
    .values({
      productId,
      title: `预售${sequence}`,
      status: 'active',
      paymentMode: 'full',
      price: '49.00',
      originalPrice: '60.00',
      stock: 10,
      perOrderQuantity: 1,
      shipAfterDays: 7,
      startAt: OPEN,
      endAt: CLOSE,
      ...values,
    })
    .returning({ id: presaleActivities.id });
  return String(row!.id);
}

describe('GET /api/v1/groupbuy/activities?ids=', () => {
  it('answers the picked activities in the order picked, skipping the invisible', async () => {
    const first = await groupbuyActivity({ sortOrder: 1 });
    const paused = await groupbuyActivity({ status: 'paused' });
    const ended = await groupbuyActivity({ endAt: new Date('2026-05-20T00:00:00.000Z') });
    const last = await groupbuyActivity({ sortOrder: 9 });
    await groupbuyActivity({ sortOrder: 5 }); // visible, not picked

    const { GET } = await import('./groupbuy/activities/route');
    const picked = [first, paused, ended, last];
    const response = await GET(get(`/api/v1/groupbuy/activities?ids=${picked.join(',')}`));
    expect(await idsOf(response)).toEqual([first, last]);

    // The list's own order is `sortOrder DESC`; `ids` overrides it.
    const reversed = await GET(get(`/api/v1/groupbuy/activities?ids=${last}&ids=${first}`));
    expect(await idsOf(reversed)).toEqual([last, first]);
    const paged = await GET(
      get(`/api/v1/groupbuy/activities?ids=${first},${last}&pageSize=1&page=2`),
    );
    expect(await idsOf(paged)).toEqual([last]);
  });

  it('answers, with productId as well, the picked activities that are that product’s', async () => {
    // 商品详情 asks by productId, a DIY component by ids; both at once is the
    // intersection, in the picked order — never the product's whole list.
    const productId = await product();
    const mine = await groupbuyActivity({ productId: Number(productId) });
    const other = await groupbuyActivity();
    const alsoMine = await groupbuyActivity({ productId: Number(productId) });
    await groupbuyActivity({ productId: Number(productId) }); // that product's, not picked

    const { GET } = await import('./groupbuy/activities/route');
    const both = await GET(
      get(`/api/v1/groupbuy/activities?ids=${alsoMine},${other},${mine}&productId=${productId}`),
    );
    expect(both.status).toBe(200);
    const body = (await both.json()) as { total: number };
    expect(body.total).toBe(2);
    expect(
      await idsOf(
        await GET(
          get(
            `/api/v1/groupbuy/activities?ids=${alsoMine},${other},${mine}&productId=${productId}`,
          ),
        ),
      ),
    ).toEqual([alsoMine, mine]);

    const none = await GET(get(`/api/v1/groupbuy/activities?ids=${other}&productId=${productId}`));
    expect(await idsOf(none)).toEqual([]);
  });

  it('refuses more than 100 ids', async () => {
    const { GET } = await import('./groupbuy/activities/route');
    const response = await GET(get(`/api/v1/groupbuy/activities?ids=${tooMany}`));
    expect(response.status).toBe(422);
  });
});

describe('GET /api/v1/presale/activities?ids=', () => {
  it('answers the picked activities in the order picked, skipping the invisible', async () => {
    const first = await presaleActivity({ sortOrder: 1 });
    const draft = await presaleActivity({ status: 'draft' });
    const later = await presaleActivity({ startAt: new Date('2026-06-10T00:00:00.000Z') });
    const last = await presaleActivity({ sortOrder: 9 });
    await presaleActivity({ sortOrder: 5 }); // visible, not picked

    const { GET } = await import('./presale/activities/route');
    const picked = [first, draft, later, last];
    const response = await GET(get(`/api/v1/presale/activities?ids=${picked.join(',')}`));
    expect(await idsOf(response)).toEqual([first, last]);

    const reversed = await GET(get(`/api/v1/presale/activities?ids=${last},${first}`));
    expect(await idsOf(reversed)).toEqual([last, first]);
  });

  it('answers, with productId as well, the picked activities that are that product’s', async () => {
    // 商品详情 asks by productId, a DIY component by ids; both at once is the
    // intersection, in the picked order — never the product's whole list.
    const productId = await product();
    const mine = await presaleActivity({ productId: Number(productId) });
    const other = await presaleActivity();
    const alsoMine = await presaleActivity({ productId: Number(productId) });
    await presaleActivity({ productId: Number(productId) }); // that product's, not picked

    const { GET } = await import('./presale/activities/route');
    const both = await GET(
      get(`/api/v1/presale/activities?ids=${alsoMine},${other},${mine}&productId=${productId}`),
    );
    expect(both.status).toBe(200);
    const body = (await both.json()) as { total: number };
    expect(body.total).toBe(2);
    expect(
      await idsOf(
        await GET(
          get(`/api/v1/presale/activities?ids=${alsoMine},${other},${mine}&productId=${productId}`),
        ),
      ),
    ).toEqual([alsoMine, mine]);

    const none = await GET(get(`/api/v1/presale/activities?ids=${other}&productId=${productId}`));
    expect(await idsOf(none)).toEqual([]);
  });

  it('refuses more than 100 ids', async () => {
    const { GET } = await import('./presale/activities/route');
    const response = await GET(get(`/api/v1/presale/activities?ids=${tooMany}`));
    expect(response.status).toBe(422);
  });
});
