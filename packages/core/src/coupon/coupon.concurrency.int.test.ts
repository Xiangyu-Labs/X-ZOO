import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as repo from './coupon.repo';
import * as service from './coupon.service';

/**
 * The races. COUPON-006, COUPON-007 and COUPON-008 from `docs/invariants.md`
 * are the three the ledger requires; the rest are here because every
 * conditional state change in the domain owes one.
 *
 * Two things make these real rather than decorative:
 *
 *  - `runConcurrently` releases every caller from one barrier, so they collide
 *    inside the same statement instead of running in sequence;
 *  - each caller gets its own `Ctx` from `forkTestCtx`, so they hold *different*
 *    pooled connections. Sharing one connection would serialise them and every
 *    assertion below would pass for the wrong reason.
 *
 * Where a caller returns a `conditionalUpdate` result, `isWinner` must read
 * `.won`: the default "truthy" treats `{ affected: 0, won: false }` as a win
 * and the test silently proves nothing.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
});

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

/** A caller with its own connection pool, acting as this user. */
function racer(userId: number): Ctx {
  return forkTestCtx(harness, { actor: userActor(userId) });
}

let sequence = 0;

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `race-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

async function makeTemplate(
  overrides: Partial<typeof couponTemplates.$inferInsert> = {},
): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name: `券${sequence}`,
      status: 'active',
      claimMode: 'manual',
      discountAmount: '10.00',
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: false,
      totalCount: 1,
      remainingCount: 1,
      perUserLimit: 1,
      ...overrides,
    })
    .returning({ id: couponTemplates.id });
  return row!.id;
}

/** `user_coupons.source_order_id` is a foreign key, so the gift race needs a real order. */
async function makeOrder(userId: number): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo: `RACE${sequence}`,
      userId,
      platform: 'h5',
      status: 'paid',
      totalQuantity: 1,
      itemsAmount: '500.00',
      payableAmount: '500.00',
      paidAmount: '500.00',
      paidAt: harness.clock.now(),
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  return row!.id;
}

const templateRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(couponTemplates)
    .where(eq(couponTemplates.id, id))
    .then((rows) => rows[0]!);

const walletRows = () => harness.ctx.db.select().from(userCoupons);

// ---------------------------------------------------------------------------
// COUPON-006
// ---------------------------------------------------------------------------

describe('COUPON-006 — one coupon, two orders at the same instant', () => {
  it('lets exactly one redemption win', async () => {
    const userId = await makeUser();
    const templateId = await makeTemplate();
    const claimed = await service.claim(racer(userId), { id: String(templateId) });
    const userCouponId = Number(claimed.coupon.id);

    // Ten concurrent checkouts for one coupon. Nine must be told no.
    const report = await runConcurrently(10, (index) => {
      const ctx = racer(userId);
      return withTx(ctx.db, (tx) =>
        service.redeem(tx, ctx, { userCouponId, userId, orderId: index + 1 }),
      );
    });

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(9);
    // Every loser learned it lost the same way — a 409, never a 500.
    for (const error of report.rejected) {
      expect(error).toMatchObject({ name: 'DomainError', code: 'COUPON_NOT_USABLE' });
    }

    const [row] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, userCouponId));
    expect(row?.status).toBe('used');
    expect(row?.usedAt).not.toBeNull();
  });

  it('is the UPDATE that decides, not a prior read — the repo statement alone', async () => {
    const userId = await makeUser();
    const templateId = await makeTemplate();
    const claimed = await service.claim(racer(userId), { id: String(templateId) });
    const userCouponId = Number(claimed.coupon.id);

    const report = await runConcurrently(
      8,
      () => {
        const ctx = racer(userId);
        return withTx(ctx.db, (tx) =>
          repo.redeemUserCoupon(tx, { id: userCouponId, userId, now: ctx.clock.now() }),
        );
      },
      // Without this, `{ affected: 0, won: false }` counts as a win and the
      // assertion below passes even when the guard is broken.
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);
  });

  it('releases once, however many retries the ledger makes', async () => {
    const userId = await makeUser();
    const templateId = await makeTemplate();
    const claimed = await service.claim(racer(userId), { id: String(templateId) });
    const userCouponId = Number(claimed.coupon.id);
    await withTx(harness.ctx.db, (tx) =>
      service.redeem(tx, harness.ctx, { userCouponId, userId, orderId: 1 }),
    );

    const report = await runConcurrently(
      6,
      () => {
        const ctx = racer(userId);
        return withTx(ctx.db, (tx) => service.release(tx, ctx, { userCouponId, orderId: 1 }));
      },
      { isWinner: (result) => result.released },
    );

    expect(report.winners).toBe(1);
    // A release never throws: the losers are ordinary `{ released: false }`.
    expect(report.rejected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// COUPON-007
// ---------------------------------------------------------------------------

describe('COUPON-007 — the last coupon, claimed by two people at once', () => {
  it('hands the last one to exactly one claimant', async () => {
    const templateId = await makeTemplate({ totalCount: 1, remainingCount: 1 });
    const userIds = await Promise.all(Array.from({ length: 12 }, () => makeUser()));

    const report = await runConcurrently(userIds.length, (index) =>
      service.claim(racer(userIds[index]!), { id: String(templateId) }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(11);
    for (const error of report.rejected) {
      expect(error).toMatchObject({ name: 'DomainError', code: 'COUPON_SOLD_OUT' });
    }

    expect((await templateRow(templateId)).remainingCount).toBe(0);
    // The eleven losers left nothing behind: no half-issued wallet rows.
    expect(await walletRows()).toHaveLength(1);
  });

  it('never oversells a larger supply and never goes negative', async () => {
    const supply = 5;
    const templateId = await makeTemplate({ totalCount: supply, remainingCount: supply });
    const userIds = await Promise.all(Array.from({ length: 20 }, () => makeUser()));

    const report = await runConcurrently(userIds.length, (index) =>
      service.claim(racer(userIds[index]!), { id: String(templateId) }),
    );

    expect(report.fulfilled).toHaveLength(supply);
    expect(report.rejected).toHaveLength(userIds.length - supply);
    const row = await templateRow(templateId);
    expect(row.remainingCount).toBe(0);
    expect(row.remainingCount).toBeGreaterThanOrEqual(0);
    expect(await walletRows()).toHaveLength(supply);
    // The supply and the wallet agree: issued = total - remaining.
    expect(row.totalCount! - row.remainingCount!).toBe(supply);
  });

  it('decrements the supply conditionally — the repo statement alone', async () => {
    const templateId = await makeTemplate({ totalCount: 3, remainingCount: 3 });

    const report = await runConcurrently(
      10,
      () => {
        const ctx = racer(1);
        return withTx(ctx.db, (tx) =>
          repo.takeOneFromSupply(tx, { templateId, now: ctx.clock.now() }),
        );
      },
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(3);
    expect(report.losers).toBe(7);
    expect((await templateRow(templateId)).remainingCount).toBe(0);
  });

  it('leaves an unlimited template alone under load', async () => {
    const templateId = await makeTemplate({
      isUnlimitedSupply: true,
      totalCount: null,
      remainingCount: null,
    });
    const userIds = await Promise.all(Array.from({ length: 10 }, () => makeUser()));

    const report = await runConcurrently(userIds.length, (index) =>
      service.claim(racer(userIds[index]!), { id: String(templateId) }),
    );
    expect(report.rejected).toHaveLength(0);
    expect(await walletRows()).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// COUPON-008
// ---------------------------------------------------------------------------

describe('COUPON-008 — one user tapping 领取 twice', () => {
  it('holds the per-user limit, and the unique violation surfaces as a 409', async () => {
    const userId = await makeUser();
    const templateId = await makeTemplate({
      perUserLimit: 1,
      totalCount: 100,
      remainingCount: 100,
    });

    const report = await runConcurrently(8, () =>
      service.claim(racer(userId), { id: String(templateId) }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(7);
    // `user_coupons_slot_uq` refused the insert. That must arrive as the domain
    // refusal, never as a raw 23505 turning into a 500.
    for (const error of report.rejected) {
      expect(error).toMatchObject({
        name: 'DomainError',
        code: 'COUPON_PER_USER_LIMIT_REACHED',
      });
    }

    expect(await walletRows()).toHaveLength(1);
    // The seven losers did NOT consume supply. This is why `issueOne` inserts
    // the wallet row before decrementing: the reverse order leaks a coupon per
    // concurrent double-tap.
    expect((await templateRow(templateId)).remainingCount).toBe(99);
  });

  it('never lets simultaneous taps exceed a limit above one', async () => {
    // Worth knowing, and worth copying: `claim_slot` is computed from what is
    // committed, so taps that read before the first winner commits all aim at
    // the same slot and one of them lands. A tap that reads after a commit aims
    // at the next slot and lands too, legitimately. So one burst of taps gets
    // **at least one and never more than the limit**, in dense slots — the
    // limit is a ceiling, never a quota the race fills. Refusing is the likely
    // direction, not a guaranteed one: on a loaded machine a racer can reach
    // its read after the first commit (STAB-001).
    const userId = await makeUser();
    const templateId = await makeTemplate({
      perUserLimit: 3,
      totalCount: 100,
      remainingCount: 100,
    });

    const report = await runConcurrently(10, () =>
      service.claim(racer(userId), { id: String(templateId) }),
    );

    const landed = report.fulfilled.length;
    expect(landed).toBeGreaterThanOrEqual(1);
    expect(landed).toBeLessThanOrEqual(3);
    // Distinct, dense, within the limit.
    expect((await walletRows()).map((row) => row.claimSlot).sort()).toEqual(
      [1, 2, 3].slice(0, landed),
    );
    expect((await templateRow(templateId)).remainingCount).toBe(100 - landed);
    for (const error of report.rejected) {
      expect(error).toMatchObject({ code: 'COUPON_PER_USER_LIMIT_REACHED' });
    }

    // Sequentially, the same user reaches the limit and then stops.
    for (let slot = landed + 1; slot <= 3; slot += 1) {
      await service.claim(racer(userId), { id: String(templateId) });
    }
    await expect(service.claim(racer(userId), { id: String(templateId) })).rejects.toMatchObject({
      code: 'COUPON_PER_USER_LIMIT_REACHED',
    });

    expect((await walletRows()).map((row) => row.claimSlot).sort()).toEqual([1, 2, 3]);
    expect((await templateRow(templateId)).remainingCount).toBe(97);
  });

  it('issues the new-user gift once when registration is retried concurrently', async () => {
    await makeTemplate({ claimMode: 'new_user', totalCount: 100, remainingCount: 100 });
    const userId = await makeUser();

    const report = await runConcurrently(
      6,
      () => {
        const ctx = racer(userId);
        return withTx(ctx.db, (tx) => service.grantNewUser(tx, ctx, userId));
      },
      { isWinner: (granted) => granted === 1 },
    );

    expect(report.winners).toBe(1);
    expect(await walletRows()).toHaveLength(1);
  });

  it('issues the order gift once when the payment callback is replayed concurrently', async () => {
    const templateId = await makeTemplate({
      claimMode: 'order_gift',
      perUserLimit: null,
      totalCount: 100,
      remainingCount: 100,
    });
    const userId = await makeUser();
    const orderId = await makeOrder(userId);

    const report = await runConcurrently(
      6,
      () => {
        const ctx = racer(userId);
        return withTx(ctx.db, (tx) =>
          service.grantOrderGifts(tx, ctx, {
            userId,
            orderId,
            productIds: [],
            paidAmount: Money.parse('500.00'),
          }),
        );
      },
      { isWinner: (result) => result.granted === 1 },
    );

    // `user_coupons_order_gift_uq` is what makes the handler safely retryable.
    expect(report.winners).toBe(1);
    expect(await walletRows()).toHaveLength(1);
    expect((await templateRow(templateId)).remainingCount).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// the remaining conditional updates
// ---------------------------------------------------------------------------

describe('the admin conditional updates', () => {
  it('lets one of two simultaneous status toggles win', async () => {
    const templateId = await makeTemplate({ status: 'draft' });

    const report = await runConcurrently(
      6,
      () => {
        const ctx = racer(1);
        return withTx(ctx.db, (tx) =>
          repo.setTemplateStatus(tx, {
            id: templateId,
            from: ['draft', 'disabled'],
            to: 'active',
            now: ctx.clock.now(),
          }),
        );
      },
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(1);
    expect((await templateRow(templateId)).status).toBe('active');
  });

  it('lets one of two simultaneous deletes win', async () => {
    const templateId = await makeTemplate();

    const report = await runConcurrently(
      4,
      () => {
        const ctx = racer(1);
        return withTx(ctx.db, (tx) =>
          repo.softDeleteTemplate(tx, { id: templateId, now: ctx.clock.now() }),
        );
      },
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(1);
  });

  it('sweeps an expiring coupon exactly once under two workers', async () => {
    const userId = await makeUser();
    const templateId = await makeTemplate({
      perUserLimit: null,
      totalCount: 10,
      remainingCount: 10,
    });
    for (let i = 0; i < 4; i += 1) {
      await service.claim(racer(userId), { id: String(templateId) });
    }
    harness.clock.advance(31 * 24 * 60 * 60 * 1000);

    const report = await runConcurrently(3, () => {
      const ctx = racer(userId);
      return withTx(ctx.db, (tx) => repo.expireOverdue(tx, { now: ctx.clock.now(), limit: 100 }));
    });

    // Every row is expired, and the four expiries were shared out rather than
    // done three times over.
    expect(report.fulfilled.reduce((sum, swept) => sum + swept, 0)).toBe(4);
    const rows = await walletRows();
    expect(rows.every((row) => row.status === 'expired')).toBe(true);
  });
});
