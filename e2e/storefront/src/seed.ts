import { hashPassword } from '@shop/core/auth';
import { adminProductCreate, adminCategoryCreate } from '@shop/core/catalog';
import {
  adminCreate as couponAdminCreate,
  adminGrant as couponAdminGrant,
} from '@shop/core/coupon';
import {
  createDocument as createDecorDocument,
  designate as designateDecor,
  publish as publishDecor,
} from '@shop/core/decor';
import { paymentConfig } from '@shop/core/payment';
import { templates as shippingTemplates } from '@shop/core/shipping';
import { addressCreate } from '@shop/core/user';
import { siteConfig, wechatMiniConfig } from '@shop/core/system';
import { wechatConfig } from '@shop/core/wechat';
import type { Actor } from '@shop/core/kernel';
import type { FakeWechatGateway } from '@shop/testing';
import { admins } from '@shop/db/schema/auth';
import { productSkus } from '@shop/db/schema/catalog';
import { cities, expressCompanies } from '@shop/db/schema/reference';
import { groupbuyActivities, groupbuyActivitySkus } from '@shop/db/schema/groupbuy';
import { presaleActivities, presaleActivitySkus } from '@shop/db/schema/presale';
import { users } from '@shop/db/schema/user';
import { eq } from 'drizzle-orm';

import { POSTAGE_PRODUCT_DESCRIPTION, SITE } from './site';
import { ctxFor } from './stack';
import type { SeededUser } from './stack-file';

/**
 * Everything the journeys need to already exist, and nothing else.
 *
 * The same rule `@shop/e2e-admin`'s seed follows applies here, mirrored: a
 * product, a coupon template, a decorated 首页 are made through the services
 * that back the admin console, because *creating* them is not what any of the
 * journeys is about — the journeys start from a shop that is already
 * open. A group-buy team mid-flight or a paid order is different: nothing a
 * shopper does *before* the journey starts should itself be exercising the
 * code the journey exists to test, so those are direct inserts, exactly as
 * `groupbuy.int.test.ts` and `presale.checkout.int.test.ts` arrange them.
 *
 * Nothing here configures SMS or Aliyun; the payment/wechat config this seed
 * writes points at the fakes `scripts/serve.ts` starts, never at a real
 * WeChat endpoint.
 */

const PASSWORD = 'e2e-Passw0rd!';

// A 1x1 PNG, so every image the decorated pages and the product pages try to
// load resolves offline with no console error.
const E2E_IMAGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function userActor(id: number): Actor {
  return { kind: 'user', id, permissions: [], isSuper: false };
}

export interface SeedResult {
  admin: { account: string; password: string; id: number };
  users: { primary: SeededUser; secondary: SeededUser };
  fixtures: {
    categoryId: number;
    multiSpecProductId: number;
    multiSpecSkuIds: number[];
    postageProductId: number;
    postageSkuId: number;
    postageFreightTemplateId: number;
    activityProductId: number;
    activitySkuId: number;
    couponTemplateId: number;
    groupBuyActivityId: number;
    presaleActivityId: number;
    primaryAddressId: number;
    secondaryAddressId: number;
    expressCompanyId: number;
    /** The mini-program's 首页 (店铺装修). */
    decorHomeId: number;
    division: { provinceId: string; cityId: string; districtId: string };
  };
}

export async function seedE2E(options: {
  databaseUrl: string;
  redisUrl: string;
  uploadsDir: string;
  /** The fake gateway `scripts/serve.ts` already started, and the edge origin its notifications are addressed to. */
  gateway: FakeWechatGateway;
  /** Where `web` sends gateway API calls — the fake gateway itself (`gateway.url`). */
  gatewayApiUrl: string;
  baseUrl: string;
  /**
   * Sign-in through the fake `api.weixin.qq.com` (`startFakeOaServer`). The mini app id is the gateway's `appId`, which the
   * serve script made equal to the fake's mini app id, because WeChat Pay
   * charges a mini-program payment to the mini-program's own app id.
   */
  miniProgram: { appSecret: string; apiBaseUrl: string };
}): Promise<SeedResult> {
  const parts = ctxFor(options);
  const { ctx, db } = parts;
  try {
    // Points the payment domain at the fake gateway, never at a real WeChat
    // endpoint — `notifyBaseUrl` is the edge origin, so the gateway's async
    // notification (delivered through `src/gateway-control.ts`) reaches the
    // real `/api/v1/webhooks/wechat-pay` route through the same proxy path a
    // real WeChat callback would.
    await ctx.config.set(paymentConfig, {
      mchId: options.gateway.keys.mchId,
      apiV3Key: options.gateway.keys.apiV3Key,
      certSerial: options.gateway.keys.merchantSerial,
      merchantPrivateKey: options.gateway.keys.merchantPrivateKeyPem,
      platformPublicKeyId: options.gateway.keys.platformSerial,
      platformPublicKey: options.gateway.keys.platformPublicKeyPem,
      notifyBaseUrl: options.baseUrl,
      apiBaseUrl: options.gatewayApiUrl,
      payExpiryMinutes: 30,
    });
    // The shop's own name, logo and copyright (`app-config.spec.ts`) — distinct from
    // every bundled default, so a page that ignores site config shows it.
    await ctx.config.set(siteConfig, { ...SITE });
    await ctx.config.set(wechatConfig, {
      miniAppId: options.gateway.keys.appId,
      oaAppId: options.gateway.keys.appId,
      miniAppSecret: options.miniProgram.appSecret,
      apiBaseUrl: options.miniProgram.apiBaseUrl,
    });
    // 小程序登录 is off until an operator turns it on; the shop keeps the
    // default 「微信登录需绑定手机号」, so a new shopper meets phone-required.
    await ctx.config.set(wechatMiniConfig, { enabled: true, name: 'E2E 小程序' });

    await db
      .insert(expressCompanies)
      .values([
        // `wechatDeliveryId`: WeChat's own code, which 发货信息管理's upload needs (mini suite).
        { code: 'shunfeng', name: '顺丰速运', sortOrder: 1, wechatDeliveryId: 'SF' },
        { code: 'zhongtong', name: '中通快递', sortOrder: 2, wechatDeliveryId: 'ZTO' },
      ])
      .onConflictDoNothing();
    const [courier] = await db
      .select({ id: expressCompanies.id })
      .from(expressCompanies)
      .where(eq(expressCompanies.code, 'shunfeng'))
      .limit(1);

    const hash = await hashPassword(PASSWORD, 4);
    const [admin] = await db
      .insert(admins)
      .values({ account: 'e2e-super', passwordHash: hash, name: '超级管理员', isSuper: true })
      .returning({ id: admins.id });

    // Two shoppers: the primary one every journey but group-buy uses, and a
    // second one only the group-buy journey needs — to join a team someone
    // else opened, a second identity has to exist before the journey starts.
    // Neither is logged in here: a fixture logs in through the real
    // `POST /api/v1/auth/sessions/password` route, the storefront analogue of
    // `@shop/e2e-admin`'s `loginCookies` — cheap enough that paying for it
    // is not a tax, and it means no token ever has to cross the process
    // boundary between this seed and the Playwright spec process.
    const primary = await makeUser(parts, {
      account: 'e2e-shopper',
      phone: '13800000001',
      nickname: '小明',
    });
    const secondary = await makeUser(parts, {
      account: 'e2e-shopper-2',
      phone: '13800000002',
      nickname: '小红',
    });

    // The shoppers' addresses have to resolve to a real division: freight is
    // priced on the address's city *path* (`shipping.freight.port.ts`
    // `cityPathOf`), and an address with no `cityId` quotes no freight at all
    // — the fallback region is never even consulted. The template database
    // has no division reference data (`db:seed` loads it, the template skips it),
    // so the one path the journeys ship to is inserted here.
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
        parentId: province!.id,
        level: 1,
        code: '440300000000',
        name: '深圳市',
        mergerName: '广东,深圳',
      })
      .returning({ id: cities.id });
    const [district] = await db
      .insert(cities)
      .values({
        parentId: city!.id,
        level: 2,
        code: '440305000000',
        name: '南山区',
        mergerName: '广东,深圳,南山',
      })
      .returning({ id: cities.id });
    const division = {
      provinceId: String(province!.id),
      cityId: String(city!.id),
      districtId: String(district!.id),
    };

    const primaryAddress = await addressCreate(ctx.as(userActor(primary.id)), {
      receiverName: '小明',
      receiverPhone: primary.phone,
      ...division,
      provinceName: '广东省',
      cityName: '深圳市',
      districtName: '南山区',
      detail: '科技园路 1 号',
      isDefault: true,
    });
    const secondaryAddress = await addressCreate(ctx.as(userActor(secondary.id)), {
      receiverName: '小红',
      receiverPhone: secondary.phone,
      ...division,
      provinceName: '广东省',
      cityName: '深圳市',
      districtName: '南山区',
      detail: '科技园路 2 号',
      isDefault: true,
    });

    const category = await adminCategoryCreate(ctx, {
      parentId: null,
      name: 'E2E 类目',
      sortOrder: 0,
      isVisible: true,
    });

    // A fixed-postage freight template: one fallback region, quantity-charged,
    // ¥6 for the first unit and ¥2 for every unit after — so the checkout
    // journey has a real, non-zero freight line to assert against.
    const template = await shippingTemplates.create(ctx, {
      name: 'E2E 运费模板',
      chargeMode: 'quantity',
      hasFreeRules: false,
      hasNoDeliveryRules: false,
      sortOrder: 0,
      regions: [
        {
          isFallback: true,
          cityIds: [],
          firstUnit: 1,
          firstPrice: '6.00',
          additionalUnit: 1,
          additionalPrice: '2.00',
        },
      ],
      freeRules: [],
      noDeliveryCityIds: [],
    });

    // A multi-spec product: two specs (颜色 x 尺码), four SKUs, free freight —
    // journey 1 (home/category/product) asserts the spec picker and the price
    // range; journey 2 (cart/checkout) buys a specific SKU off it.
    const multiSpec = await adminProductCreate(ctx, {
      name: 'E2E 多规格商品',
      sliderImages: [E2E_IMAGE_URL],
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: E2E_IMAGE_URL,
      displaySalesBoost: 0,
      specMode: true,
      specs: [
        { name: '颜色', values: [{ value: '白' }, { value: '黑' }] },
        { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
      ],
      skus: [
        {
          specValues: { 颜色: '白', 尺码: 'M' },
          price: '59.00',
          stock: 50,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
        {
          specValues: { 颜色: '白', 尺码: 'L' },
          price: '65.00',
          stock: 50,
          isDefault: false,
          isVisible: true,
          sortOrder: 1,
        },
        {
          specValues: { 颜色: '黑', 尺码: 'M' },
          price: '59.00',
          stock: 50,
          isDefault: false,
          isVisible: true,
          sortOrder: 2,
        },
        {
          specValues: { 颜色: '黑', 尺码: 'L' },
          price: '65.00',
          stock: 50,
          isDefault: false,
          isVisible: true,
          sortOrder: 3,
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
      categoryIds: [category.id],
      labelIds: [],
      protectionIds: [],
      params: [],
      recommendedProductIds: [],
      giftCouponIds: [],
    });
    const multiSpecSkuIds = (
      await db
        .select({ id: productSkus.id })
        .from(productSkus)
        .where(eq(productSkus.productId, Number(multiSpec.id)))
        .orderBy(productSkus.sortOrder)
    ).map((r) => r.id);

    // A single-SKU product behind the fixed-postage template — journey 1
    // asserts its freight line reads the template's quote, not ¥0.
    const postage = await adminProductCreate(ctx, {
      name: 'E2E 运费商品',
      sliderImages: [E2E_IMAGE_URL],
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: E2E_IMAGE_URL,
      displaySalesBoost: 0,
      specMode: false,
      specs: [],
      skus: [
        {
          specValues: {},
          price: '39.00',
          stock: 50,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
      freightMode: 'template',
      shippingTemplateId: String(template.id),
      purchaseLimitMode: 'none',
      minPurchaseQuantity: 1,
      isHot: false,
      isNew: false,
      isBest: false,
      isBenefit: false,
      isRecommended: false,
      sortOrder: 1,
      descriptionHtml: `<p>${POSTAGE_PRODUCT_DESCRIPTION}</p>`,
      categoryIds: [category.id],
      labelIds: [],
      protectionIds: [],
      params: [],
      recommendedProductIds: [],
      giftCouponIds: [],
    });
    const postageSkuId = await firstSkuId(parts, Number(postage.id));

    // The product both activities are attached to — a third, plain product,
    // so neither activity spec depends on the freight/spec fixtures above.
    const activityProduct = await adminProductCreate(ctx, {
      name: 'E2E 活动商品',
      sliderImages: [E2E_IMAGE_URL],
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: E2E_IMAGE_URL,
      displaySalesBoost: 0,
      specMode: false,
      specs: [],
      skus: [
        {
          specValues: {},
          price: '88.00',
          stock: 200,
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
      sortOrder: 2,
      descriptionHtml: '',
      categoryIds: [category.id],
      labelIds: [],
      protectionIds: [],
      params: [],
      recommendedProductIds: [],
      giftCouponIds: [],
    });
    const activitySkuId = await firstSkuId(parts, Number(activityProduct.id));

    // A coupon template, granted to both shoppers so the checkout journey has
    // one to apply and the group-buy journey's second shopper is not blocked
    // by a per-user cap it never asked for.
    const coupon = await couponAdminCreate(ctx, {
      name: 'E2E 满减券',
      scope: 'all_products',
      claimMode: 'manual',
      status: 'active',
      discountAmount: '5.00',
      minSpend: '0.00',
      validityMode: 'days_after_claim',
      validFrom: undefined,
      validTo: undefined,
      validDays: 30,
      claimFrom: undefined,
      claimTo: undefined,
      isUnlimitedSupply: false,
      totalCount: 100,
      perUserLimit: 5,
      giftMinOrderAmount: undefined,
      sortOrder: 0,
      productIds: [],
      categoryIds: [],
    });
    await couponAdminGrant(
      ctx,
      { id: coupon.id },
      { userIds: [String(primary.id), String(secondary.id)] },
    );

    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [groupbuy] = await db
      .insert(groupbuyActivities)
      .values({
        productId: Number(activityProduct.id),
        title: 'E2E 拼团活动',
        imageUrl: E2E_IMAGE_URL,
        status: 'active',
        price: '68.00',
        originalPrice: '88.00',
        seatsRequired: 2,
        groupTtlSeconds: 86_400,
        stock: 100,
        totalQuota: null,
        perOrderQuantity: 2,
        startAt: past,
        endAt: future,
      })
      .returning({ id: groupbuyActivities.id });
    await db.insert(groupbuyActivitySkus).values({
      activityId: groupbuy!.id,
      skuId: activitySkuId,
      price: '68.00',
      stock: 100,
      quota: null,
      isEnabled: true,
    });

    const [presale] = await db
      .insert(presaleActivities)
      .values({
        productId: Number(activityProduct.id),
        title: 'E2E 预售活动',
        status: 'active',
        paymentMode: 'full',
        price: '78.00',
        stock: 100,
        perOrderQuantity: 3,
        startAt: past,
        endAt: future,
        shipAfterDays: 7,
      })
      .returning({ id: presaleActivities.id });
    await db.insert(presaleActivitySkus).values({
      activityId: presale!.id,
      skuId: activitySkuId,
      price: '78.00',
      stock: 100,
      isEnabled: true,
    });

    // The mini-program's 首页, a 店铺装修 document: a search bar, a 分类 entry into the E2E category, and that category's
    // products — what the mini journeys start from.
    const decorHome = await createDecorDocument(ctx, {
      kind: 'home',
      name: 'E2E 首页',
      document: decorHomeDocument(String(category.id)),
    });
    await publishDecor(ctx, { id: decorHome.id, note: 'E2E' });
    await designateDecor(ctx, { designation: 'home', documentId: decorHome.id });

    return {
      admin: { account: 'e2e-super', password: PASSWORD, id: admin!.id },
      users: { primary, secondary },
      fixtures: {
        categoryId: Number(category.id),
        multiSpecProductId: Number(multiSpec.id),
        multiSpecSkuIds,
        postageProductId: Number(postage.id),
        postageSkuId,
        postageFreightTemplateId: Number(template.id),
        activityProductId: Number(activityProduct.id),
        activitySkuId,
        couponTemplateId: Number(coupon.id),
        groupBuyActivityId: groupbuy!.id,
        presaleActivityId: presale!.id,
        primaryAddressId: Number(primaryAddress.id),
        secondaryAddressId: Number(secondaryAddress.id),
        expressCompanyId: Number(courier!.id),
        decorHomeId: Number(decorHome.id),
        division,
      },
    };
  } finally {
    await parts.close();
  }
}

/** Titles the mini journeys look for on the v2 首页. */
export const DECOR_HOME = {
  search: '搜索 E2E 商品',
  categoryEntry: 'E2E 分类',
  gridTitle: 'E2E 精选',
} as const;

function decorHomeDocument(categoryId: string) {
  const style = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
  const visibility = { audience: 'all', platforms: [] } as const;
  const category = { kind: 'category', id: categoryId } as const;
  return {
    schemaVersion: 2 as const,
    root: {
      props: { title: 'E2E 商城', background: '#f5f5f5', shareEnabled: true, shareTitle: '' },
    },
    blocks: [
      {
        id: 'e2e-search',
        type: 'searchBar',
        v: 1,
        props: {
          placeholder: DECOR_HOME.search,
          hotWords: [],
          shape: 'round',
          sticky: false,
          style,
          visibility,
        },
      },
      {
        id: 'e2e-nav',
        type: 'navGrid',
        v: 1,
        props: {
          items: [{ icon: E2E_IMAGE_URL, label: DECOR_HOME.categoryEntry, link: category }],
          columns: 4,
          rows: 1,
          paging: false,
          iconShape: 'circle',
          style,
          visibility,
        },
      },
      {
        id: 'e2e-title',
        type: 'titleBar',
        v: 1,
        props: {
          title: DECOR_HOME.gridTitle,
          subtitle: '',
          align: 'left',
          moreText: '更多',
          style,
          visibility,
        },
      },
      {
        id: 'e2e-grid',
        type: 'productGrid',
        v: 2,
        props: {
          source: { mode: 'category', categoryId, sort: 'default', limit: 6 },
          layout: 'grid2',
          titleLines: 2,
          showMarketPrice: false,
          showTag: false,
          style,
          visibility,
        },
      },
    ],
  };
}

async function makeUser(
  parts: ReturnType<typeof ctxFor>,
  args: { account: string; phone: string; nickname: string },
): Promise<SeededUser> {
  const hash = await hashPassword(PASSWORD, 4);
  const [row] = await parts.db
    .insert(users)
    .values({
      account: args.account,
      phone: args.phone,
      nickname: args.nickname,
      passwordHash: hash,
      passwordAlgo: 'bcrypt',
      passwordVersion: 1,
      status: 'active',
    })
    .returning({ id: users.id });
  const id = row!.id;
  return {
    id,
    account: args.account,
    phone: args.phone,
    password: PASSWORD,
    nickname: args.nickname,
  };
}

async function firstSkuId(parts: ReturnType<typeof ctxFor>, productId: number): Promise<number> {
  const rows = await parts.db
    .select({ id: productSkus.id })
    .from(productSkus)
    .where(eq(productSkus.productId, productId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`seed: product ${productId} has no sku`);
  return row.id;
}
