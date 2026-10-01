import { dep } from './deps';

/**
 * The storefront the load run shops in.
 *
 * Built through the same core services the admin uses (categories, products,
 * the 首页, the payment config), plus direct inserts only for what no
 * service creates: shopper accounts with a password. Shoppers then sign in over
 * HTTP (`POST /api/v1/auth/sessions/password`) and add an address over HTTP,
 * exactly as the app does — see `run.ts`.
 */

export interface SeedOptions {
  databaseUrl: string;
  redisUrl: string;
  uploadsDir: string;
  /** Fake WeChat Pay gateway keys and URL. */
  gateway: {
    url: string;
    keys: {
      mchId: string;
      apiV3Key: string;
      merchantSerial: string;
      merchantPrivateKeyPem: string;
      platformSerial: string;
      platformPublicKeyPem: string;
      appId: string;
    };
  };
  /** Where the app is served; the payment notify URL is built from it. */
  appOrigin: string;
  shoppers: number;
  products: number;
}

export interface SeedResult {
  categoryIds: string[];
  products: { id: string; skuId: string; price: string; categoryId: string }[];
  shoppers: { account: string; password: string; id: number }[];
  /** The 省 / 市 / 区 ids every shopper's address points at. */
  region: { provinceId: string; cityId: string; districtId: string };
}

export const SHOPPER_PASSWORD = 'LoadTest-Passw0rd';

const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * The 首页 (店铺装修): a search bar and two product grids, so a home request
 * resolves blocks and reads the catalog like the real page does.
 */
function homeDocument(categoryIds: readonly string[]) {
  const style = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
  const visibility = { audience: 'all', platforms: [] } as const;
  const grid = (categoryId: string, n: number) => ({
    id: `load-grid-${n}`,
    type: 'productGrid',
    v: 2,
    props: {
      source: { mode: 'category', categoryId, sort: 'default', limit: 10 },
      layout: 'grid2',
      titleLines: 2,
      showMarketPrice: false,
      showTag: false,
      style,
      visibility,
    },
  });
  return {
    schemaVersion: 2 as const,
    root: {
      props: { title: '商城首页', background: '#f5f5f5', shareEnabled: true, shareTitle: '' },
    },
    blocks: [
      {
        id: 'load-search',
        type: 'searchBar',
        v: 1,
        props: {
          placeholder: '搜索商品',
          hotWords: [],
          shape: 'round',
          sticky: false,
          style,
          visibility,
        },
      },
      ...categoryIds.slice(0, 2).map((id, n) => grid(id, n)),
    ],
  };
}

export async function seedStorefront(options: SeedOptions): Promise<SeedResult> {
  const { ctxFor } = await import('../../e2e/admin/src/stack');
  const catalog = await dep('@shop/core/catalog');
  const decor = await dep('@shop/core/decor');
  const payment = await dep('@shop/core/payment');
  const wechat = await dep('@shop/core/wechat');
  const auth = await dep('@shop/core/auth');
  const { users } = await dep('@shop/db/schema/user');
  const { cities } = await dep('@shop/db/schema/reference');
  const { productSkus } = await dep('@shop/db/schema/catalog');
  const { eq } = await dep('drizzle-orm');

  const parts = ctxFor(options);
  const { ctx, db } = parts;
  try {
    // -- payment: WeChat Pay v3 pointed at the harness's fake gateway ---------
    await ctx.config.set(payment.paymentConfig, {
      mchId: options.gateway.keys.mchId,
      apiV3Key: options.gateway.keys.apiV3Key,
      certSerial: options.gateway.keys.merchantSerial,
      merchantPrivateKey: options.gateway.keys.merchantPrivateKeyPem,
      platformPublicKeyId: options.gateway.keys.platformSerial,
      platformPublicKey: options.gateway.keys.platformPublicKeyPem,
      notifyBaseUrl: options.appOrigin,
      apiBaseUrl: options.gateway.url,
      payExpiryMinutes: 30,
    });
    await ctx.config.set(wechat.wechatConfig, {
      miniAppId: options.gateway.keys.appId,
      oaAppId: options.gateway.keys.appId,
    });

    // -- the region an address points at ------------------------------------
    // `user_addresses.{province,city,district}_id` reference `cities`, which
    // the template leaves empty (the ~3000-row reference seed is not on
    // `@shop/db`'s exports map). Three rows are all an address needs.
    const [province] = await db
      .insert(cities)
      .values({
        parentId: null,
        level: 0,
        code: '440000000000',
        name: '广东省',
        mergerName: '广东',
      })
      .returning({ id: cities.id });
    const [city] = await db
      .insert(cities)
      .values({
        parentId: province.id,
        level: 1,
        code: '440300000000',
        name: '深圳市',
        mergerName: '广东,深圳',
      })
      .returning({ id: cities.id });
    const [district] = await db
      .insert(cities)
      .values({
        parentId: city.id,
        level: 2,
        code: '440305000000',
        name: '南山区',
        mergerName: '广东,深圳,南山',
      })
      .returning({ id: cities.id });
    const region = {
      provinceId: String(province.id),
      cityId: String(city.id),
      districtId: String(district.id),
    };

    // -- categories: three parents, two children each ------------------------
    const leafIds: string[] = [];
    for (let p = 0; p < 3; p++) {
      const parent = await catalog.adminCategoryCreate(ctx, {
        parentId: null,
        name: `压测大类 ${p + 1}`,
        sortOrder: p,
        isVisible: true,
      });
      for (let c = 0; c < 2; c++) {
        const child = await catalog.adminCategoryCreate(ctx, {
          parentId: parent.id,
          name: `压测小类 ${p + 1}-${c + 1}`,
          sortOrder: c,
          isVisible: true,
          iconUrl: IMAGE,
        });
        leafIds.push(String(child.id));
      }
    }

    // -- products: one SKU each, stock that 75 s of orders cannot exhaust -----
    const products: SeedResult['products'] = [];
    for (let i = 0; i < options.products; i++) {
      const categoryId = leafIds[i % leafIds.length]!;
      const price = `${(19 + i * 3).toFixed(0)}.90`;
      const product = await catalog.adminProductCreate(ctx, {
        name: `压测商品 ${String(i + 1).padStart(2, '0')}`,
        sliderImages: [IMAGE, IMAGE],
        kind: 'physical',
        status: 'on_shelf',
        imageUrl: IMAGE,
        displaySalesBoost: 0,
        specMode: false,
        specs: [],
        skus: [
          {
            specValues: {},
            price,
            stock: 1_000_000,
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
        freightMode: 'free',
        purchaseLimitMode: 'none',
        minPurchaseQuantity: 1,
        isHot: i % 3 === 0,
        isNew: i % 4 === 0,
        isBest: false,
        isBenefit: false,
        isRecommended: i % 5 === 0,
        sortOrder: i,
        descriptionHtml: `<p>压测商品 ${i + 1} 的详情。</p>`.repeat(20),
        categoryIds: [categoryId],
        labelIds: [],
        protectionIds: [],
        params: [],
        recommendedProductIds: [],
        giftCouponIds: [],
      });
      const [sku] = await db
        .select({ id: productSkus.id })
        .from(productSkus)
        .where(eq(productSkus.productId, Number(product.id)))
        .limit(1);
      products.push({ id: String(product.id), skuId: String(sku.id), price, categoryId });
    }

    // -- the 首页 (店铺装修), published and designated ---------------------------
    const home = await decor.createDocument(ctx, {
      kind: 'home',
      name: '压测首页',
      document: homeDocument(leafIds),
    });
    await decor.publish(ctx, { id: home.id, note: 'load' });
    await decor.designate(ctx, { designation: 'home', documentId: home.id });

    // -- shoppers: an account with a password, nothing else --------------------
    const hash = await auth.hashPassword(SHOPPER_PASSWORD, 4);
    const rows = await db
      .insert(users)
      .values(
        Array.from({ length: options.shoppers }, (_, i) => ({
          account: `load-shopper-${String(i + 1).padStart(3, '0')}`,
          nickname: `压测买家 ${i + 1}`,
          passwordHash: hash,
          passwordAlgo: 'bcrypt' as const,
        })),
      )
      .returning({ id: users.id, account: users.account });
    const shoppers = rows.map((row: { id: number; account: string }) => ({
      account: row.account,
      password: SHOPPER_PASSWORD,
      id: row.id,
    }));

    return { categoryIds: leafIds, products, shoppers, region };
  } finally {
    await parts.close();
  }
}
