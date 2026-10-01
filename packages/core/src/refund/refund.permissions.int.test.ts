import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders } from '@shop/db/schema/order';
import { refundLogs, refunds } from '@shop/db/schema/refund';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import { createTestCtx, flushTestRedis, forkTestCtx, type TestCtx } from '@shop/testing';
import { registerAllDomains } from '../domains.gen';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { configGet, configSave } from '../system';
import { refundPermissions } from './permissions';
import * as admin from './refund.admin';
import { refundConfig } from './refund.config';
import * as service from './refund.service';

/**
 * The refund domain's permission atoms, asserted one at a time for an admin
 * who is **not** a super admin.
 *
 * Every other refund test builds its operator with `isSuper: true`. That
 * short-circuits `hasPermission` before it reads a single atom, so nothing
 * there shows what a narrow role can and cannot do.

 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  registerAllDomains();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
});

/** An admin with a real id and exactly the atoms given. */
const adminWith = (permissions: string[], id = 7): Actor => ({
  kind: 'admin',
  id,
  permissions,
  isSuper: false,
});

const as = (actor: Actor): Ctx => forkTestCtx(harness, { actor });

async function refusalOf(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    const value = await run();
    throw new Error(`expected a refusal, got ${JSON.stringify(value)}`);
  } catch (error) {
    if (!DomainError.is(error)) throw error;
    return error;
  }
}

// ---------------------------------------------------------------------------
// the 售后设置 group
// ---------------------------------------------------------------------------

describe('who may rewrite the return address', () => {
  const redirect = { values: { returnAddress: '别处 1 号' } };

  it.each([
    ['the remark atom', ['refund:request:read', 'refund:request:write']],
    ['the review atom', ['refund:request:read', 'refund:request:review']],
    ['the execute atom', ['refund:request:read', 'refund:request:execute']],
    ['reading the group', ['refund:config:read']],
  ])('refuses %s, and the address stays where it was', async (_label, atoms) => {
    const refusal = await refusalOf(() =>
      configSave(as(adminWith(atoms)), { group: 'refund' }, redirect),
    );

    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.details).toEqual({ permission: 'refund:config:write' });
    expect((await harness.ctx.config.get(refundConfig)).returnAddress).toBe('');
  });

  it('shows the group to refund:config:read, as read-only', async () => {
    const view = await configGet(as(adminWith(['refund:config:read'])), { group: 'refund' });
    expect(view.descriptor.permission).toBe('refund:config:read');
  });

  it('lets refund:config:write change it', async () => {
    await configSave(
      as(adminWith(['refund:config:read', 'refund:config:write'])),
      { group: 'refund' },
      redirect,
    );

    expect((await harness.ctx.config.get(refundConfig)).returnAddress).toBe('别处 1 号');
  });
});

// ---------------------------------------------------------------------------
// the request atoms, one at a time
// ---------------------------------------------------------------------------

const ALL_REQUEST_ATOMS = [
  refundPermissions['request:read'],
  refundPermissions['request:review'],
  refundPermissions['request:execute'],
  refundPermissions['request:write'],
];

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const superAdmin = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

interface Scene {
  ownerId: number;
  adminId: number;
  refundId: number;
}

let sequence = 0;

/** One paid order and one `applied` after-sale on it, of the kind asked for. */
async function scene(kind: 'refund_only' | 'return_and_refund'): Promise<Scene> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;
  const [owner] = await db
    .insert(users)
    .values({ account: `perm-owner-${n}` })
    .returning({ id: users.id });
  const [operator] = await db
    .insert(admins)
    .values({ account: `perm-admin-${n}`, passwordHash: 'x'.repeat(60), name: `运营${n}` })
    .returning({ id: admins.id });
  const [product] = await db
    .insert(products)
    .values({
      name: '权限测试商品',
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: '50.00',
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `PERM${n}`, price: '50.00', stock: 100 })
    .returning({ id: productSkus.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `PM${String(n).padStart(10, '0')}`,
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
      snapshot: {
        productName: '权限测试商品',
        productImageUrl: 'https://cdn.example.test/p.jpg',
        productKind: 'physical',
        skuCode: `PERM${n}`,
        specText: '默认',
        specValues: {},
      },
    })
    .returning({ id: orderItems.id });

  // A return is only approved with somewhere to send the goods.
  if (kind === 'return_and_refund') {
    await harness.ctx.config.set(refundConfig, {
      returnName: '售后部',
      returnPhone: '13800000000',
      returnAddress: '浙江省杭州市西湖区文一西路 1 号',
    });
  }

  const applied = await service.apply(as(userActor(owner!.id)), {
    orderId: String(order!.id),
    kind,
    lines: [{ orderItemId: String(item!.id), quantity: 1 }],
    reason: '不想要了',
    images: [],
    includeFreight: false,
  });

  return {
    ownerId: owner!.id,
    adminId: operator!.id,
    refundId: Number(applied.id),
  };
}

const refundRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, id))
    .then((rows) => rows[0]!);

const logsOf = (id: number) =>
  harness.ctx.db.select().from(refundLogs).where(eq(refundLogs.refundId, id));

const refundEffects = () =>
  harness.ctx.db.select().from(effectsTable).where(eq(effectsTable.scope, 'refund'));

/** A snapshot of everything an admin action could have written. */
async function written(id: number) {
  return { row: await refundRow(id), logs: await logsOf(id), effects: await refundEffects() };
}

type Act = (ctx: Ctx, id: string) => Promise<unknown>;

/** Every admin action, the atom it needs, and the state it is tried from. */
const ACTIONS: [string, string, 'applied' | 'approved', Act][] = [
  [
    'the list',
    'refund:request:read',
    'applied',
    (ctx) => admin.adminList(ctx, { page: 1, pageSize: 20 }),
  ],
  ['the detail', 'refund:request:read', 'applied', (ctx, id) => admin.adminDetail(ctx, { id })],
  ['同意', 'refund:request:review', 'applied', (ctx, id) => admin.adminApprove(ctx, { id })],
  [
    '拒绝',
    'refund:request:review',
    'applied',
    (ctx, id) => admin.adminReject(ctx, { id, rejectReason: '不符合条件' }),
  ],
  [
    '确认收货',
    'refund:request:execute',
    'approved',
    (ctx, id) => admin.adminReceiveReturn(ctx, { id }),
  ],
  ['重试', 'refund:request:execute', 'approved', (ctx, id) => admin.adminRetry(ctx, { id })],
  [
    '备注',
    'refund:request:write',
    'applied',
    (ctx, id) => admin.adminRemark(ctx, { id, adminRemark: '看一下' }),
  ],
];

async function sceneAt(state: 'applied' | 'approved'): Promise<Scene> {
  const s = await scene('return_and_refund');
  if (state === 'approved') {
    await admin.adminApprove(as(superAdmin(s.adminId)), { id: String(s.refundId) });
  }
  return s;
}

describe('each refund admin action refused for an admin without its atom', () => {
  it.each(ACTIONS)(
    'refuses %s to an admin holding every other refund atom, and writes nothing',
    async (_label, atom, state, act) => {
      const s = await sceneAt(state);
      const before = await written(s.refundId);
      const others = [...ALL_REQUEST_ATOMS.filter((a) => a !== atom), 'refund:config:write'];

      const refusal = await refusalOf(() =>
        act(as(adminWith(others, s.adminId)), String(s.refundId)),
      );

      expect(refusal.code).toBe('FORBIDDEN');
      expect(refusal.status).toBe(403);
      expect(refusal.details).toEqual({ permission: atom });
      expect(await written(s.refundId)).toEqual(before);
    },
  );

  it.each(ACTIONS.filter(([, atom]) => atom !== 'refund:request:execute'))(
    'serves %s to an admin holding just its atom (and read)',
    async (_label, atom, state, act) => {
      // The refusals above are only worth something if the same call with the
      // atom really gets through. 确认收货 / 重试 are the next describe's.
      const s = await sceneAt(state);
      await expect(
        act(as(adminWith(['refund:request:read', atom], s.adminId)), String(s.refundId)),
      ).resolves.toBeDefined();
    },
  );
});

describe('review and execute are separate grants', () => {
  it('request:review approves but cannot confirm the goods came back or retry', async () => {
    const s = await scene('return_and_refund');
    const reviewer = as(adminWith(['refund:request:read', 'refund:request:review'], s.adminId));

    await admin.adminApprove(reviewer, { id: String(s.refundId) });
    expect((await refundRow(s.refundId)).status).toBe('approved');
    const before = await written(s.refundId);

    for (const act of [
      () => admin.adminReceiveReturn(reviewer, { id: String(s.refundId) }),
      () => admin.adminRetry(reviewer, { id: String(s.refundId) }),
    ]) {
      const refusal = await refusalOf(act);
      expect(refusal.code).toBe('FORBIDDEN');
      expect(refusal.details).toEqual({ permission: 'refund:request:execute' });
    }
    expect(await written(s.refundId)).toEqual(before);
  });

  it('request:review alone cannot send a return somewhere other than 售后设置', async () => {
    const s = await scene('return_and_refund');
    const elsewhere = {
      name: '二号仓',
      phone: '13900000000',
      address: '江苏省南京市雨花台区 2 号',
    };
    const reviewer = as(adminWith(['refund:request:read', 'refund:request:review'], s.adminId));
    const before = await written(s.refundId);

    const refusal = await refusalOf(() =>
      admin.adminApprove(reviewer, { id: String(s.refundId), returnAddress: elsewhere }),
    );
    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.details).toEqual({ permission: 'refund:config:write' });
    expect(await written(s.refundId)).toEqual(before);

    const owner = as(
      adminWith(['refund:request:read', 'refund:request:review', 'refund:config:write'], s.adminId),
    );
    await admin.adminApprove(owner, { id: String(s.refundId), returnAddress: elsewhere });
    expect((await refundRow(s.refundId)).returnAddress).toEqual(elsewhere);
  });

  it('request:execute confirms the return but cannot approve or reject', async () => {
    const s = await scene('return_and_refund');
    const executor = as(adminWith(['refund:request:read', 'refund:request:execute'], s.adminId));
    const before = await written(s.refundId);

    for (const act of [
      () => admin.adminApprove(executor, { id: String(s.refundId) }),
      () => admin.adminReject(executor, { id: String(s.refundId), rejectReason: '不符合条件' }),
    ]) {
      const refusal = await refusalOf(act);
      expect(refusal.code).toBe('FORBIDDEN');
      expect(refusal.details).toEqual({ permission: 'refund:request:review' });
    }
    expect(await written(s.refundId)).toEqual(before);

    // Once somebody who may review has said yes, the executor does their half.
    await admin.adminApprove(as(superAdmin(s.adminId)), { id: String(s.refundId) });
    await admin.adminReceiveReturn(executor, { id: String(s.refundId) });
    expect((await refundRow(s.refundId)).status).toBe('processing');
  });
});
