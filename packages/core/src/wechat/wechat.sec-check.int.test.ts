import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { productReviews, productSkus, products } from '@shop/db/schema/catalog';
import { notificationMessages } from '@shop/db/schema/notification';
import { orderItems, orders } from '@shop/db/schema/order';
import { attachments } from '@shop/db/schema/storage';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  runConcurrently,
  type TestCtx,
} from '@shop/testing';
import { buildMiniPush, startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import * as catalog from '../catalog';
import { drainEffects } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import { registerNotificationDomain } from '../notification';
import * as order from '../order';
import { siteConfig } from '../system';
import * as user from '../user';
import {
  contentSecurityConfig,
  handleMiniPush,
  listMediaChecks,
  registerWechatDomain,
  resetWechatTokenFlight,
  wechatConfig,
} from './index';

/**
 * 内容安全 (C09) against a real PostgreSQL and the fake `api.weixin.qq.com`:
 * review text held for a person rather than refused, nicknames and invoice
 * titles refused only when WeChat says `risky`, and pictures checked by push.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const TOKEN = 'mini-push-token-0001';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ORIGIN = 'https://shop.example.com';
const RISKY = '违规测试';
const DOUBTFUL = '待定测试';
const DOWN = { errcode: -1, errmsg: 'system error' };

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'wechat-mini' });
  oa = await startFakeOaServer();
}, 180_000);

afterAll(async () => {
  await oa?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  oa.reset();
  resetWechatTokenFlight();
  registerNotificationDomain();
  registerWechatDomain();
  catalog.registerCatalogDomain();
  user.registerUserDomain();
  await harness.ctx.config.set(wechatConfig, {
    miniAppId: oa.miniAppId,
    miniAppSecret: oa.miniAppSecret,
    apiBaseUrl: oa.url,
    miniToken: TOKEN,
    miniAesKey: AES_KEY,
    miniMessageMode: 'safe',
  });
  await harness.ctx.config.set(siteConfig, { publicOrigin: ORIGIN });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });
const as = (userId: number): Ctx => harness.as(userActor(userId));

async function makeAdmin(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account: `op-${sequence}`, passwordHash: 'x', name: `运营${sequence}` })
    .returning({ id: admins.id });
  return row!.id;
}

/** A customer; with `mini`, one WeChat can check content for. */
async function makeUser(options: { mini?: boolean } = {}): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `u-${sequence}`, nickname: `顾客${sequence}` })
    .returning({ id: users.id });
  if (options.mini ?? true) {
    await harness.ctx.db
      .insert(wechatIdentities)
      .values({ userId: row!.id, platform: 'mini', openid: `o-mini-${sequence}` });
  }
  return row!.id;
}

/** A completed order line the customer may review. */
async function makeReviewableLine(userId: number): Promise<{ productId: number; line: string }> {
  sequence += 1;
  const now = harness.clock.now();
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 50,
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
      stock: 50,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  const [placed] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo: `SC${String(sequence).padStart(8, '0')}`,
      userId,
      platform: 'wechat_mini',
      status: 'completed',
      fulfillmentStatus: 'fulfilled',
      totalQuantity: 1,
      itemsAmount: '60.00',
      payableAmount: '60.00',
      paidAmount: '60.00',
      paidAt: now,
      receivedAt: now,
      completedAt: now,
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '浙江省',
      receiverCity: '杭州市',
      receiverDetail: '文三路 100 号',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: orders.id });
  const [item] = await harness.ctx.db
    .insert(orderItems)
    .values({
      orderId: placed!.id,
      productId: product!.id,
      skuId: sku!.id,
      itemKey: `k-${sequence}`,
      quantity: 1,
      unitPrice: '60.00',
      totalAmount: '60.00',
      snapshot: {
        productName: `商品${sequence}`,
        productImageUrl: 'https://cdn.example.com/p.jpg',
        productKind: 'physical',
        skuCode: `SKU-${sequence}`,
        specText: '默认',
        specValues: {},
      },
      createdAt: now,
    })
    .returning({ id: orderItems.id });
  return { productId: product!.id, line: String(item!.id) };
}

async function submit(userId: number, content: string, images: string[] = []) {
  const { productId, line } = await makeReviewableLine(userId);
  const review = await catalog.reviewSubmit(as(userId), {
    orderItemId: line,
    productScore: 5,
    serviceScore: 5,
    content,
    images,
  });
  return { productId, review };
}

async function reviewRow(id: string) {
  const [row] = await harness.ctx.db
    .select()
    .from(productReviews)
    .where(eq(productReviews.id, Number(id)));
  return row!;
}

async function publicReviews(productId: number) {
  return catalog.productReviews(
    harness.ctx,
    { id: String(productId) },
    { rating: 'all', page: 1, pageSize: 20 },
  );
}

/** A push as WeChat sends it, stamped with the harness clock. */
function push(message: Record<string, unknown>) {
  return buildMiniPush({
    token: TOKEN,
    aesKey: AES_KEY,
    appId: oa.miniAppId,
    message,
    mode: 'safe',
    timestamp: Math.floor(harness.ctx.clock.now().getTime() / 1000),
  });
}

async function storeAttachment(url: string): Promise<void> {
  sequence += 1;
  await harness.ctx.db.insert(attachments).values({
    storageKey: url.replace(/^\/uploads\//, ''),
    driver: 'local',
    url,
    name: 'avatar.png',
    kind: 'image',
    mime: 'image/png',
    size: 26,
    sha256: String(sequence).padStart(64, 'a'),
  });
}

const textChecks = () => oa.callsTo('/wxa/msg_sec_check');

// ---------------------------------------------------------------------------
// review text
// ---------------------------------------------------------------------------

describe('review text is held for a person, never refused', () => {
  it('publishes a review WeChat passes, checked as a comment for the author — CONTENT-001', async () => {
    const userId = await makeUser();
    const { productId, review } = await submit(userId, '面料很舒服');

    expect(review.moderation).toBe('published');
    expect(await reviewRow(review.id)).toMatchObject({
      status: 'published',
      moderationReason: null,
    });
    expect(textChecks()).toHaveLength(1);
    expect(textChecks()[0]!.body).toMatchObject({
      content: '面料很舒服',
      version: 2,
      scene: 2,
      openid: expect.stringMatching(/^o-mini-/),
    });
    expect((await publicReviews(productId)).total).toBe(1);
  });

  it('saves a risky review 待审核 with a neutral answer, not an error — CONTENT-001', async () => {
    const userId = await makeUser();
    const { productId, review } = await submit(userId, `这个${RISKY}真不错`);

    expect(review.moderation).toBe('pending');
    expect(review.content).toBe(`这个${RISKY}真不错`);
    expect(await reviewRow(review.id)).toMatchObject({
      status: 'pending',
      moderationReason: 'sec_check_risky',
    });
    expect((await publicReviews(productId)).total).toBe(0);
    // Its author still finds it under 我的评价, marked as waiting.
    const mine = await catalog.myReviews(as(userId), { page: 1, pageSize: 20 });
    expect(mine.items.map((item) => [item.id, item.status])).toEqual([[review.id, 'pending']]);
  });

  it('holds a review WeChat wants a person to look at — CONTENT-001', async () => {
    const userId = await makeUser();
    const { review } = await submit(userId, `有点${DOUBTFUL}`);
    expect(review.moderation).toBe('pending');
    expect((await reviewRow(review.id)).moderationReason).toBe('sec_check_review');
  });

  it('holds the review when WeChat cannot answer, rather than publishing it unchecked — CONTENT-001', async () => {
    const userId = await makeUser();
    oa.behaviour.failSecCheck = DOWN;
    const { productId, review } = await submit(userId, '很好');

    expect(review.moderation).toBe('pending');
    expect((await reviewRow(review.id)).moderationReason).toBe('sec_check_unavailable');
    expect((await publicReviews(productId)).total).toBe(0);
  });

  it('holds the review when the call never arrives — CONTENT-001', async () => {
    const userId = await makeUser();
    const { line } = await makeReviewableLine(userId);
    // Point the client at a port nothing listens on: a transport failure.
    await harness.ctx.config.set(wechatConfig, { apiBaseUrl: 'http://127.0.0.1:9' });
    const review = await catalog.reviewSubmit(as(userId), {
      orderItemId: line,
      productScore: 5,
      serviceScore: 5,
      content: '很好',
      images: [],
    });
    expect(review.moderation).toBe('pending');
    expect((await reviewRow(review.id)).moderationReason).toBe('sec_check_unavailable');
  });

  it('publishes a held review once an admin approves it — CONTENT-001', async () => {
    const userId = await makeUser();
    const adminId = await makeAdmin();
    const { productId, review } = await submit(userId, `这个${RISKY}真不错`);

    const approved = await catalog.adminReviewSetStatus(
      harness.as(adminActor(adminId)),
      { id: review.id },
      { status: 'published' },
    );
    expect(approved.status).toBe('published');
    expect(approved.moderationReason).toBe('sec_check_risky');
    expect((await publicReviews(productId)).items.map((item) => item.id)).toEqual([review.id]);
  });

  it('lets an admin delete a held review — CONTENT-001', async () => {
    const userId = await makeUser();
    const adminId = await makeAdmin();
    const { review } = await submit(userId, `这个${RISKY}真不错`);

    const held = await catalog.adminReviewList(harness.as(adminActor(adminId)), {
      page: 1,
      pageSize: 20,
      status: 'pending',
    });
    expect(held.items.map((item) => [item.id, item.moderationReason])).toEqual([
      [review.id, 'sec_check_risky'],
    ]);
    await catalog.adminReviewDelete(harness.as(adminActor(adminId)), { id: review.id });
    const after = await harness.ctx.db
      .select()
      .from(productReviews)
      .where(and(eq(productReviews.id, Number(review.id))));
    expect(after.every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('does not check anything while switched off, or with no mini program to check with — CONTENT-001', async () => {
    await harness.ctx.config.set(contentSecurityConfig, { enabled: false });
    const mini = await makeUser();
    const { review } = await submit(mini, `这个${RISKY}真不错`);
    expect(review.moderation).toBe('published');

    await harness.ctx.config.set(contentSecurityConfig, { enabled: true });
    await harness.ctx.config.set(wechatConfig, { miniAppId: '', miniAppSecret: '' });
    const h5Only = await makeUser({ mini: false });
    const { review: second } = await submit(h5Only, `这个${RISKY}真不错`);
    expect(second.moderation).toBe('published');
    expect(textChecks()).toHaveLength(0);
  });

  it('holds a review from an account WeChat cannot check under, rather than publishing it unread — CONTENT-006', async () => {
    // An SMS or password session from any HTTP client: no mini-program openid.
    const h5Only = await makeUser({ mini: false });
    const { productId, review } = await submit(h5Only, '很好');

    expect(review.moderation).toBe('pending');
    expect(await reviewRow(review.id)).toMatchObject({
      status: 'pending',
      moderationReason: 'sec_check_unchecked',
    });
    expect((await publicReviews(productId)).total).toBe(0);
    expect(textChecks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// nicknames and invoice titles
// ---------------------------------------------------------------------------

describe('nicknames and invoice titles are refused only when risky', () => {
  it('refuses a risky nickname and keeps the old one — CONTENT-002', async () => {
    const userId = await makeUser();
    const before = await user.getProfile(as(userId));

    await expect(
      user.updateProfile(as(userId), { nickname: `${RISKY}的名字` }),
    ).rejects.toMatchObject({ code: 'USER_NICKNAME_REJECTED' });
    expect((await user.getProfile(as(userId))).nickname).toBe(before.nickname);
    expect(textChecks()[0]!.body).toMatchObject({ scene: 1 });

    const saved = await user.updateProfile(as(userId), { nickname: `${DOUBTFUL}的名字` });
    expect(saved.nickname).toBe(`${DOUBTFUL}的名字`);
  });

  it('saves a nickname when WeChat cannot answer, and does not re-check an unchanged one — CONTENT-002', async () => {
    const userId = await makeUser();
    oa.behaviour.failSecCheck = DOWN;
    const saved = await user.updateProfile(as(userId), { nickname: '新名字' });
    expect(saved.nickname).toBe('新名字');

    oa.reset();
    await user.updateProfile(as(userId), { nickname: '新名字' });
    expect(textChecks()).toHaveLength(0);
  });

  it('refuses a risky 抬头 in the book, and saves one when WeChat is down — CONTENT-003', async () => {
    const userId = await makeUser();
    const form = (name: string) => ({
      headerType: 'personal' as const,
      invoiceType: 'plain' as const,
      name,
      isDefault: false,
    });
    await expect(user.invoiceTitleCreate(as(userId), form(`${RISKY}公司`))).rejects.toMatchObject({
      code: 'USER_INVOICE_TITLE_REJECTED',
    });

    const created = await user.invoiceTitleCreate(as(userId), form('张三'));
    await expect(
      user.invoiceTitleUpdate(as(userId), { id: created.id }, form(`${RISKY}公司`)),
    ).rejects.toMatchObject({ code: 'USER_INVOICE_TITLE_REJECTED' });

    oa.behaviour.failSecCheck = DOWN;
    const saved = await user.invoiceTitleCreate(as(userId), form('李四'));
    expect(saved.name).toBe('李四');
    const book = await user.invoiceTitleList(as(userId), { page: 1, pageSize: 20 });
    expect(book.items.map((title) => title.name).sort()).toEqual(['张三', '李四'].sort());
  });

  it('refuses a risky 抬头 on an invoice request, and takes one when WeChat is down — CONTENT-003', async () => {
    const userId = await makeUser();
    const { line } = await makeReviewableLine(userId);
    const [item] = await harness.ctx.db
      .select({ orderId: orderItems.orderId })
      .from(orderItems)
      .where(eq(orderItems.id, Number(line)));
    const id = String(item!.orderId);
    const header = (name: string) => ({
      headerType: 'personal' as const,
      invoiceType: 'plain' as const,
      name,
    });

    await expect(
      order.orderInvoices.request(as(userId), { id }, header(`${RISKY}`)),
    ).rejects.toMatchObject({ code: 'ORDER_INVOICE_TITLE_REJECTED' });

    oa.behaviour.failSecCheck = DOWN;
    const invoice = await order.orderInvoices.request(as(userId), { id }, header('张三'));
    expect(invoice.status).toBe('requested');
  });
});

// ---------------------------------------------------------------------------
// pictures
// ---------------------------------------------------------------------------

describe('pictures are checked after the fact, by push', () => {
  const IMAGE = '/uploads/review/2026/06/01/a.png';
  const OTHER = '/uploads/review/2026/06/01/b.png';

  // A review picture must be one our storage holds (CAT-018).
  beforeEach(async () => {
    await storeAttachment(IMAGE);
    await storeAttachment(OTHER);
  });

  async function submittedChecks(reviewId: string) {
    await drainEffects(harness.ctx);
    return listMediaChecks(harness.ctx.db, 'review_image', Number(reviewId));
  }

  it('sends each review picture once, as an absolute https address — CONTENT-004', async () => {
    const userId = await makeUser();
    const { review } = await submit(userId, '很好', [IMAGE, OTHER, IMAGE]);

    const checks = await submittedChecks(review.id);
    expect(checks.map((check) => check.status)).toEqual(['submitted', 'submitted']);
    expect(oa.mediaChecks.map((check) => check.mediaUrl).sort()).toEqual([
      `${ORIGIN}${IMAGE}`,
      `${ORIGIN}${OTHER}`,
    ]);
    expect(oa.mediaChecks.every((check) => check.scene === 2)).toBe(true);
  });

  it('takes a risky picture off the review, and a repeated verdict does nothing more — CONTENT-004', async () => {
    const userId = await makeUser();
    const { productId, review } = await submit(userId, '很好', [IMAGE, OTHER]);
    const checks = await submittedChecks(review.id);
    const risky = checks.find((check) => check.mediaUrl === IMAGE)!;

    const verdict = oa.mediaCheckPush(risky.traceId!, 'risky', { createTime: 1_780_000_000 });
    expect(await handleMiniPush(harness.ctx, push(verdict))).toMatchObject({ status: 200 });
    await drainEffects(harness.ctx);

    expect((await reviewRow(review.id)).images).toEqual([OTHER]);
    expect((await reviewRow(review.id)).status).toBe('published');
    const [decided] = (
      await listMediaChecks(harness.ctx.db, 'review_image', Number(review.id))
    ).filter((check) => check.id === risky.id);
    expect(decided).toMatchObject({ status: 'risky', label: 20002, action: 'image_hidden' });

    // WeChat re-sends with another CreateTime: another message, the same verdict.
    const again = oa.mediaCheckPush(risky.traceId!, 'risky', { createTime: 1_780_000_060 });
    expect(await handleMiniPush(harness.ctx, push(again))).toMatchObject({ status: 200 });
    await drainEffects(harness.ctx);
    expect((await reviewRow(review.id)).images).toEqual([OTHER]);
    expect((await publicReviews(productId)).items[0]!.images).toEqual([OTHER]);
  });

  it('keeps a picture WeChat passes — CONTENT-004', async () => {
    const userId = await makeUser();
    const { review } = await submit(userId, '很好', [IMAGE]);
    const [check] = await submittedChecks(review.id);

    await handleMiniPush(harness.ctx, push(oa.mediaCheckPush(check!.traceId!, 'pass')));
    await drainEffects(harness.ctx);
    expect((await reviewRow(review.id)).images).toEqual([IMAGE]);
    const [decided] = await listMediaChecks(harness.ctx.db, 'review_image', Number(review.id));
    expect(decided).toMatchObject({ status: 'pass', action: null });
  });

  it('keeps the picture and retries while WeChat refuses the submission — CONTENT-004', async () => {
    const userId = await makeUser();
    oa.behaviour.failMediaCheck = DOWN;
    const { review } = await submit(userId, '很好', [IMAGE]);

    const first = await submittedChecks(review.id);
    expect(first[0]!.status).toBe('pending');
    expect((await reviewRow(review.id)).images).toEqual([IMAGE]);
    const [effect] = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scope, 'content-security'));
    expect(effect!.status).not.toBe('done');

    oa.behaviour.failMediaCheck = null;
    harness.clock.advance(60 * 60 * 1000);
    const after = await submittedChecks(review.id);
    expect(after[0]!.status).toBe('submitted');
  });

  it('skips the picture check for an account without a mini-program identity — CONTENT-004', async () => {
    const userId = await makeUser({ mini: false });
    const { review } = await submit(userId, '很好', [IMAGE]);
    const [check] = await submittedChecks(review.id);
    expect(check!.status).toBe('skipped');
    expect(oa.mediaChecks).toHaveLength(0);
    // The text already held it for the same reason (CONTENT-006); nothing to add.
    expect(check!.action).toBe('none');
    expect(await reviewRow(review.id)).toMatchObject({
      status: 'pending',
      moderationReason: 'sec_check_unchecked',
    });
  });

  it('sends a published review back to 待审核 when WeChat will not check its picture (61010) — CONTENT-006', async () => {
    const userId = await makeUser();
    const { productId, review } = await submit(userId, '很好', [IMAGE, OTHER]);
    expect(review.moderation).toBe('published');
    oa.behaviour.failMediaCheck = { errcode: 61010, errmsg: 'user is not recently active' };

    const checks = await submittedChecks(review.id);
    // Whichever picture is skipped first holds the review; the second finds it held.
    expect(checks.map((check) => check.status)).toEqual(['skipped', 'skipped']);
    expect(checks.map((check) => check.action).sort()).toEqual(['none', 'review_held']);
    expect(await reviewRow(review.id)).toMatchObject({
      status: 'pending',
      moderationReason: 'sec_check_image_unchecked',
      images: [IMAGE, OTHER],
    });
    expect((await publicReviews(productId)).total).toBe(0);

    // A redelivered effect finds the checks decided and moves nothing.
    await drainEffects(harness.ctx);
    expect((await reviewRow(review.id)).moderationReason).toBe('sec_check_image_unchecked');
  });

  it('holds the review when the shop has no https address to show WeChat the picture at — CONTENT-006', async () => {
    await harness.ctx.config.set(siteConfig, { publicOrigin: 'http://shop.example.com' });
    const userId = await makeUser();
    const { review } = await submit(userId, '很好', [IMAGE]);

    const [check] = await submittedChecks(review.id);
    expect(check).toMatchObject({ status: 'skipped', action: 'review_held' });
    expect(oa.mediaChecks).toHaveLength(0);
    expect((await reviewRow(review.id)).status).toBe('pending');
  });

  it('leaves a review an admin already approved when its picture turns out uncheckable — CONTENT-006', async () => {
    const userId = await makeUser();
    const adminId = await makeAdmin();
    oa.behaviour.failMediaCheck = DOWN;
    const { review } = await submit(userId, `这个${RISKY}真不错`, [IMAGE]);
    await drainEffects(harness.ctx);
    await catalog.adminReviewSetStatus(
      harness.as(adminActor(adminId)),
      { id: review.id },
      { status: 'published' },
    );

    oa.behaviour.failMediaCheck = { errcode: 61010, errmsg: 'user is not recently active' };
    harness.clock.advance(60 * 60 * 1000);
    const [check] = await submittedChecks(review.id);
    expect(check).toMatchObject({ status: 'skipped', action: 'none' });
    expect(await reviewRow(review.id)).toMatchObject({
      status: 'published',
      moderationReason: 'sec_check_risky',
    });
  });

  it('acts once when two different verdict pushes for one picture race — CONTENT-004', async () => {
    const userId = await makeUser();
    const { review } = await submit(userId, '很好', [IMAGE, OTHER]);
    const checks = await submittedChecks(review.id);
    const target = checks.find((check) => check.mediaUrl === IMAGE)!;

    for (const createTime of [1_780_000_000, 1_780_000_001]) {
      await handleMiniPush(
        harness.ctx,
        push(oa.mediaCheckPush(target.traceId!, 'risky', { createTime })),
      );
    }
    const report = await runConcurrently(2, async () => {
      await drainEffects(forkTestCtx(harness));
    });
    expect(report.rejected).toEqual([]);
    await drainEffects(harness.ctx);

    expect((await reviewRow(review.id)).images).toEqual([OTHER]);
    const [decided] = (
      await listMediaChecks(harness.ctx.db, 'review_image', Number(review.id))
    ).filter((check) => check.id === target.id);
    expect(decided).toMatchObject({ status: 'risky', action: 'image_hidden' });
  });

  it('resets a risky avatar and tells the customer — CONTENT-005', async () => {
    const userId = await makeUser();
    const AVATAR = '/uploads/avatar/2026/06/01/c.png';
    await storeAttachment(AVATAR);
    await user.updateProfile(as(userId), { avatarUrl: AVATAR });

    await drainEffects(harness.ctx);
    const [check] = await listMediaChecks(harness.ctx.db, 'avatar', userId);
    expect(check).toMatchObject({ status: 'submitted', scene: 1 });

    await handleMiniPush(harness.ctx, push(oa.mediaCheckPush(check!.traceId!, 'risky')));
    await drainEffects(harness.ctx);

    expect((await user.getProfile(as(userId))).avatarUrl).toBeNull();
    const [decided] = await listMediaChecks(harness.ctx.db, 'avatar', userId);
    expect(decided).toMatchObject({ status: 'risky', action: 'avatar_reset' });
    const notices = await harness.ctx.db
      .select()
      .from(notificationMessages)
      .where(eq(notificationMessages.userId, userId));
    expect(notices.map((notice) => notice.code)).toEqual([user.AVATAR_REJECTED_EVENT]);
  });

  it('leaves an avatar the customer has since replaced — CONTENT-005', async () => {
    const userId = await makeUser();
    const FIRST = '/uploads/avatar/2026/06/01/d.png';
    const SECOND = '/uploads/avatar/2026/06/01/e.png';
    await storeAttachment(FIRST);
    await storeAttachment(SECOND);
    await user.updateProfile(as(userId), { avatarUrl: FIRST });
    await drainEffects(harness.ctx);
    const [check] = await listMediaChecks(harness.ctx.db, 'avatar', userId);
    await user.updateProfile(as(userId), { avatarUrl: SECOND });

    await handleMiniPush(harness.ctx, push(oa.mediaCheckPush(check!.traceId!, 'risky')));
    await drainEffects(harness.ctx);

    expect((await user.getProfile(as(userId))).avatarUrl).toBe(SECOND);
    const [decided] = await listMediaChecks(harness.ctx.db, 'avatar', userId);
    expect(decided).toMatchObject({ status: 'risky', action: 'none' });
  });

  it('does not check an avatar that did not change — CONTENT-005', async () => {
    const userId = await makeUser();
    const AVATAR = '/uploads/avatar/2026/06/01/f.png';
    await storeAttachment(AVATAR);
    await user.updateProfile(as(userId), { avatarUrl: AVATAR });
    await user.updateProfile(as(userId), { avatarUrl: AVATAR, nickname: '换个名字' });
    expect(await listMediaChecks(harness.ctx.db, 'avatar', userId)).toHaveLength(1);
  });
});
