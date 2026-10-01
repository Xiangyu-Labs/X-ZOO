import type { AdminProductForm } from '@shop/contracts/catalog/schemas';
import { admins } from '@shop/db/schema/auth';
import { orderItems, orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
import type { TestCtx } from '@shop/testing';

import type { Actor, Ctx } from '../kernel/context';
import * as repo from './catalog.repo';
import { adminCategoryCreate, adminProductCreate } from './catalog.service';

/**
 * Fixtures shared by `catalog.int.test.ts` and `catalog.concurrency.int.test.ts`.
 *
 * Not a `.test.ts` file, because a test file that only defines helpers fails
 * the "no tests in suite" rule; it is excluded from the package build the same
 * way the tests are.
 *
 * The order rows here are written directly rather than through checkout, so a
 * catalog test can put an order in exactly the state it needs. They exist
 * purely so the review and purchase-limit paths have something to read.
 */

let sequence = 0;

export const next = (): number => (sequence += 1);

export const adminActor = (id: number): Actor => ({
  kind: 'admin',
  id,
  permissions: [],
  isSuper: true,
});

export const userActor = (id: number): Actor => ({
  kind: 'user',
  id,
  permissions: [],
  isSuper: false,
});

/**
 * A real `admins` row.
 *
 * `product_reviews.reply_by_admin_id` carries a foreign key, so an operator
 * with a made-up id cannot reply to a review. The tests create the operator
 * rather than pretending one exists.
 */
export async function makeAdmin(harness: TestCtx): Promise<number> {
  const n = next();
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account: `admin-${n}`, passwordHash: 'x', name: `运营${n}`, isSuper: true })
    .returning({ id: admins.id });
  return row!.id;
}

export async function makeUser(harness: TestCtx): Promise<number> {
  const n = next();
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `u-${n}`, nickname: `顾客${n}` })
    .returning({ id: users.id });
  return row!.id;
}

export async function makeCategory(ctx: Ctx, name?: string): Promise<string> {
  const category = await adminCategoryCreate(ctx, {
    parentId: null,
    name: name ?? `类目${next()}`,
    sortOrder: 0,
    isVisible: true,
  });
  return category.id;
}

export function productForm(overrides: Partial<AdminProductForm> = {}): AdminProductForm {
  const base = {
    name: `经典白T恤${next()}`,
    sliderImages: [],
    kind: 'physical',
    status: 'on_shelf',
    imageUrl: 'https://example.test/p.png',
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
    categoryIds: [],
    labelIds: [],
    protectionIds: [],
    params: [],
    recommendedProductIds: [],
    giftCouponIds: [],
  } satisfies AdminProductForm;

  return { ...base, ...overrides } as AdminProductForm;
}

export async function makeProduct(ctx: Ctx, overrides: Partial<AdminProductForm> = {}) {
  const categoryIds = overrides.categoryIds ?? [await makeCategory(ctx)];
  return adminProductCreate(ctx, productForm({ ...overrides, categoryIds }));
}

export async function firstSkuId(harness: TestCtx, productId: string): Promise<number> {
  const rows = await repo.listSkus(harness.ctx.db, Number(productId));
  return rows[0]!.id;
}

/**
 * An order with one line, in a state the catalog cares about.
 *
 * `createdAt` / `updatedAt` / `completedAt` are written from the test clock
 * rather than left to `now()`: the auto-review sweep selects on
 * `orders.completed_at`, so a row stamped with the container's wall clock
 * would never come due.
 */
export async function makeOrderLine(
  harness: TestCtx,
  args: {
    userId: number;
    productId: number;
    skuId: number;
    status?: 'pending_payment' | 'paid' | 'shipped' | 'received' | 'completed';
    quantity?: number;
  },
): Promise<{ orderId: number; orderItemId: number }> {
  const n = next();
  const now = harness.clock.now();
  const quantity = args.quantity ?? 1;
  const status = args.status ?? 'completed';
  // `orders_fulfillment_matches_status`: anything at or past 已发货 must be
  // fulfilled. The fixture honours the constraint rather than working around it.
  const shipped = status === 'shipped' || status === 'received' || status === 'completed';

  const [order] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo: `SO${String(n).padStart(8, '0')}`,
      userId: args.userId,
      platform: 'h5',
      status,
      fulfillmentStatus: shipped ? 'fulfilled' : 'unfulfilled',
      totalQuantity: quantity,
      itemsAmount: '99.00',
      payableAmount: '99.00',
      paidAmount: '99.00',
      paidAt: now,
      receivedAt: status === 'received' || status === 'completed' ? now : null,
      completedAt: status === 'completed' ? now : null,
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: orders.id });

  const [item] = await harness.ctx.db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      productId: args.productId,
      skuId: args.skuId,
      itemKey: `k-${n}`,
      quantity,
      unitPrice: '99.00',
      totalAmount: '99.00',
      snapshot: {
        productName: '经典白T恤',
        productImageUrl: 'https://example.test/p.png',
        productKind: 'physical',
        skuCode: `SKU${n}`,
        specText: '白|M',
        specValues: { 颜色: '白', 尺码: 'M' },
      },
      createdAt: now,
    })
    .returning({ id: orderItems.id });

  return { orderId: order!.id, orderItemId: item!.id };
}
