import { hashPassword } from '@shop/core/auth';
import { adminProductCreate, adminCategoryCreate } from '@shop/core/catalog';
import { apply as refundApply } from '@shop/core/refund';
import type { Actor } from '@shop/core/kernel';
import { admins } from '@shop/db/schema/auth';
import { orderItems, orders } from '@shop/db/schema/order';
import { productSkus } from '@shop/db/schema/catalog';
import { expressCompanies } from '@shop/db/schema/reference';
import { configValues } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import { eq } from 'drizzle-orm';

import { ctxFor } from './stack';

/**
 * Everything the specs need to already exist, and nothing else.
 *
 * Two rules this seed follows, because a fixture that breaks either one turns
 * the suite from evidence into decoration:
 *
 *  1. **Only what the admin UI cannot create itself.** A product, a coupon, a
 *     DIY page and a role are all made *through the browser*, because making
 *     them is the thing under test. A paid order is not: in production it is a
 *     WeChat callback that pays it, and no admin screen can.
 *  2. **Nothing points at a real endpoint.** `payment.apiBaseUrl` is written to
 *     a black hole, so even a future code path that reached for the gateway
 *     despite the missing credentials would fail on a closed local port rather
 *     than talk to WeChat. Nothing here configures
 *     SMS or Aliyun at all.
 */

/** Fixture credentials. They exist only inside a throwaway container. */
const PASSWORD = 'e2e-Passw0rd!';

export interface SeedResult {
  accounts: Record<string, { account: string; password: string; id: number }>;
  fixtures: Record<string, number>;
}

function userActor(id: number): Actor {
  return { kind: 'user', id, permissions: [], isSuper: false };
}

// The dashboard's product tiles (the ranking) really load this image, so it
// must resolve offline with no console error: a 1×1 PNG inline, never a fake host.
const E2E_IMAGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export async function seedE2E(options: {
  databaseUrl: string;
  redisUrl: string;
  uploadsDir: string;
}): Promise<SeedResult> {
  const parts = ctxFor(options);
  const { ctx, db } = parts;
  try {
    // The 发货 modal reads its courier list from `GET /admin-api/express-companies`,
    // so an empty reference table would fail the order spec for a reason that
    // has nothing to do with shipping. Two rows, not `seedReference()`: that
    // helper is not on `@shop/db`'s exports map, and it also loads ~3000 cities
    // this suite never reads.
    await db
      .insert(expressCompanies)
      .values([
        { code: 'shunfeng', name: '顺丰速运', sortOrder: 1 },
        { code: 'zhongtong', name: '中通快递', sortOrder: 2 },
      ])
      .onConflictDoNothing();
    const [courier] = await db
      .select({ id: expressCompanies.id })
      .from(expressCompanies)
      .where(eq(expressCompanies.code, 'shunfeng'))
      .limit(1);

    // A gateway base URL that resolves to a closed port. Nothing in the suite
    // should reach it; if something does, it fails locally and loudly.
    await db
      .insert(configValues)
      .values({ group: 'payment', key: 'apiBaseUrl', value: 'http://127.0.0.1:9/no-gateway' })
      .onConflictDoNothing();
    // The same for WeChat (公众号, 小程序, 模板消息). `wechat-oa.spec.ts` points it
    // at the fake OA server for its own duration and puts this back.
    await db
      .insert(configValues)
      .values({ group: 'wechat', key: 'apiBaseUrl', value: 'http://127.0.0.1:9/no-wechat' })
      .onConflictDoNothing();

    const hash = await hashPassword(PASSWORD, 4);

    // The super admin. No service creates one — `adminCreate` cannot set
    // `is_super` — so this is the one identity that has to be an INSERT.
    const [superAdmin] = await db
      .insert(admins)
      .values({
        account: 'e2e-super',
        passwordHash: hash,
        name: '超级管理员',
        isSuper: true,
      })
      .returning({ id: admins.id });

    // A second identity for the lockout spec, so parking an account for
    // fifteen minutes cannot strand every other spec.
    const [lockable] = await db
      .insert(admins)
      .values({
        account: 'e2e-lockout',
        passwordHash: hash,
        name: '锁定测试',
        isSuper: true,
      })
      .returning({ id: admins.id });

    const [customer] = await db
      .insert(users)
      .values({ account: 'e2e-customer', nickname: '测试买家' })
      .returning({ id: users.id });
    const userId = customer!.id;

    // A category, because `商品分类` is required on the product form and a
    // TreeSelect cannot invent one.
    const category = await adminCategoryCreate(ctx, {
      parentId: null,
      name: 'E2E 类目',
      sortOrder: 0,
      isVisible: true,
    });

    const product = await adminProductCreate(ctx, {
      name: 'E2E 订单用商品',
      sliderImages: [],
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: E2E_IMAGE_URL,
      displaySalesBoost: 0,
      specMode: false,
      specs: [],
      skus: [
        {
          specValues: {},
          price: '99.00',
          stock: 100,
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
      categoryIds: [category.id],
      labelIds: [],
      protectionIds: [],
      params: [],
      recommendedProductIds: [],
      giftCouponIds: [],
    });

    const productId = Number(product.id);
    const skuId = await firstSkuId(db, productId);

    // Two paid orders: one the 发货 spec ships, one the 退款 spec refunds.
    // They are separate so neither spec depends on the other's order.
    const shippable = await makePaidOrder(parts, { userId, productId, skuId, no: 'E2E00000001' });
    const refundable = await makePaidOrder(parts, { userId, productId, skuId, no: 'E2E00000002' });

    // The refund request, applied *as the buyer* — `refund/index.ts` has no
    // "create on behalf of" export and the suite does not reach past it.
    const refund = await refundApply(ctx.as(userActor(userId)), {
      orderId: String(refundable.orderId),
      kind: 'refund_only',
      reason: '不想要了',
      explanation: 'e2e',
      includeFreight: false,
      images: [],
      lines: [{ orderItemId: String(refundable.orderItemId), quantity: 1 }],
    });

    return {
      accounts: {
        super: { account: 'e2e-super', password: PASSWORD, id: superAdmin!.id },
        lockable: { account: 'e2e-lockout', password: PASSWORD, id: lockable!.id },
      },
      fixtures: {
        userId,
        categoryId: Number(category.id),
        productId,
        skuId,
        expressCompanyId: Number(courier!.id),
        shippableOrderId: shippable.orderId,
        refundableOrderId: refundable.orderId,
        refundId: Number(refund.id),
      },
    };
  } finally {
    await parts.close();
  }
}

async function firstSkuId(db: ReturnType<typeof ctxFor>['db'], productId: number): Promise<number> {
  const rows = await db
    .select({ id: productSkus.id })
    .from(productSkus)
    .where(eq(productSkus.productId, productId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`seed: product ${productId} has no sku`);
  return row.id;
}

/**
 * An order that has been paid for.
 *
 * Written directly, and deliberately: the only thing that pays an order in
 * production is a signed WeChat callback, and forging one in a seed would mean
 * either holding a merchant key or weakening the verifier — both worse than an
 * INSERT that honours the same CHECK constraints (`orders_fulfillment_matches_status`
 * wants anything at or past 已发货 to be fulfilled; `paid` is not).
 */
export async function makePaidOrder(
  parts: ReturnType<typeof ctxFor>,
  args: { userId: number; productId: number; skuId: number; no: string },
): Promise<{ orderId: number; orderItemId: number }> {
  const now = parts.ctx.clock.now();
  const [order] = await parts.db
    .insert(orders)
    .values({
      orderNo: args.no,
      userId: args.userId,
      platform: 'h5',
      status: 'paid',
      fulfillmentStatus: 'unfulfilled',
      totalQuantity: 1,
      itemsAmount: '99.00',
      payableAmount: '99.00',
      paidAmount: '99.00',
      paidAt: now,
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '科技园路 1 号',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: orders.id });

  const [item] = await parts.db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      productId: args.productId,
      skuId: args.skuId,
      itemKey: `${args.no}-1`,
      quantity: 1,
      unitPrice: '99.00',
      totalAmount: '99.00',
      snapshot: {
        productName: 'E2E 订单用商品',
        productImageUrl: E2E_IMAGE_URL,
        productKind: 'physical',
        skuCode: `E2ESKU-${args.no}`,
        specText: '默认',
        specValues: {},
      },
      createdAt: now,
    })
    .returning({ id: orderItems.id });

  return { orderId: order!.id, orderItemId: item!.id };
}
