import { admins } from '@shop/db/schema/auth';
import { userAddresses, users } from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserSessionService } from '../auth/user-session.service';
import type { Actor, Ctx } from '../kernel/context';
import type { DomainError } from '../kernel/errors';
import { fakeSmsSender, registerSmsSender, resetSmsSender, type FakeSmsSender } from '../sms';
import { smsConfig, wechatMiniConfig } from '../system';
import { wechatConfig } from '../wechat';
import './index';
import * as auth from './storefront-auth.service';
import { storefrontAuthConfig } from './storefront-auth.config';
import * as admin from './user-admin.service';
import * as repo from './user.repo';
import * as service from './user.service';
import {
  fakeWechatIdentityPort,
  registerWechatIdentityPort,
  resetWechatIdentityPort,
} from './wechat-identity.port';

/**
 * Every conditional state change in `user`, raced.
 *
 * All six of these are guarded inside the statement — a unique index, a partial
 * unique index, a `WHERE` that names the value being replaced, or a Lua
 * compare-and-delete — rather than by a prior `SELECT` that two callers both
 * pass. The question each test asks is not "does it work" but "how many callers
 * believe they were the one who changed it", because a second winner here is a
 * second account for one phone number, a second sign-in off one SMS code, or a
 * second 注销 approval anonymising an account that is already gone.
 *
 * `forkTestCtx` gives every worker its own context so they really contend on
 * the row; `runConcurrently` releases them from one barrier so they collide
 * instead of queueing.
 */

let harness: TestCtx;
let sms: FakeSmsSender;
let wechat: ReturnType<typeof fakeWechatIdentityPort>;
let reviewerId = 0;

const NOW = '2026-06-01T00:00:00.000Z';
const PHONE = '13800138000';
const WORKERS = 6;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);

  sms = fakeSmsSender();
  registerSmsSender(sms);
  wechat = fakeWechatIdentityPort();
  registerWechatIdentityPort(wechat);

  await harness.ctx.config.set(smsConfig, { templateVerifyCode: 'SMS_1' });
  reviewerId = await makeAdmin();
});

afterEach(() => {
  resetSmsSender();
  resetWechatIdentityPort();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const anonymous: Actor = { kind: 'anonymous', id: null, permissions: [], isSuper: false };

/** A context of its own, so the workers contend on the database, not on a mutex. */
function fork(index: number, actor: Actor = anonymous): Ctx {
  return forkTestCtx(harness, { actor, requestId: `race-${index}` });
}

function forkUser(index: number, id: number): Ctx {
  return fork(index, { kind: 'user', id, permissions: [], isSuper: false });
}

function forkAdmin(index: number): Ctx {
  return fork(index, { kind: 'admin', id: reviewerId, permissions: [], isSuper: true });
}

async function makeAdmin(): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({
      account: 'reviewer',
      passwordHash: 'x',
      name: '审核员',
      createdAt: harness.clock.now(),
      updatedAt: harness.clock.now(),
    })
    .returning({ id: admins.id });
  return row!.id;
}

let sequence = 0;

async function makeUser(overrides: Partial<repo.InsertUserInput> = {}): Promise<repo.UserRow> {
  sequence += 1;
  const phone = `1390013${String(8000 + sequence).padStart(4, '0')}`;
  const row = await harness.ctx.withTx((tx) =>
    repo.insertUser(tx, {
      account: phone,
      phone,
      passwordHash: null,
      passwordAlgo: null,
      nickname: `用户${sequence}`,
      avatarUrl: null,
      registerSource: 'h5',
      registerIp: null,
      now: harness.clock.now(),
      ...overrides,
    }),
  );
  if (!row) throw new Error('fixture: insertUser refused');
  return row;
}

function codeOf(phone: string): string {
  const code = sms.lastCodeFor(phone);
  if (!code) throw new Error(`fixture: no code was sent to ${phone}`);
  return code;
}

function codes(errors: unknown[]): string[] {
  return errors.map((error) => (error as DomainError).code);
}

// ---------------------------------------------------------------------------
// SMS codes
// ---------------------------------------------------------------------------

describe('SMS codes', () => {
  it('lets exactly one of six concurrent verifications spend a code', async () => {
    // INVARIANT USER-010. The code lives in Redis and is consumed by a Lua
    // compare-delete-count, so the read and the delete cannot be interleaved.
    // A `GET` then `DEL` from the application would let all six callers in —
    // and that is a one-code-many-sessions bug an attacker replays at leisure.
    await auth.sendSmsCode(harness.as(anonymous), { phone: PHONE, scene: 'login' });
    const code = codeOf(PHONE);

    const report = await runConcurrently(WORKERS, (index) =>
      auth.smsLogin(fork(index), { phone: PHONE, code }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(WORKERS - 1);
    for (const failure of codes(report.rejected)) {
      // Whoever arrives second finds the key gone, not a counter to exhaust.
      expect(failure).toBe('AUTH_SMS_CODE_INVALID');
    }
    expect(await harness.ctx.db.select().from(users)).toHaveLength(1);
  });

  it('lets one of six sends through the resend guard', async () => {
    // Six taps on 获取验证码 — an impatient shopper, or a script — must cost one
    // SMS. `SET NX` decides, so the other five never reach the provider.
    const report = await runConcurrently(WORKERS, (index) =>
      auth.sendSmsCode(fork(index), { phone: PHONE, scene: 'login' }),
    );

    expect(report.fulfilled).toHaveLength(1);
    for (const failure of codes(report.rejected)) expect(failure).toBe('AUTH_SMS_TOO_FREQUENT');
    expect(sms.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('six concurrent creations of one phone number leave one account', async () => {
    // INVARIANT USER-015. Every worker's pre-read says the number is free,
    // because none of them can see a sibling transaction's uncommitted row.
    // `users_phone_lower_uq` is what actually decides, and the losers are told
    // so by `insertUser` returning `null` rather than by an exception.
    const report = await runConcurrently(
      WORKERS,
      (index) =>
        fork(index).withTx((tx) =>
          repo.insertUser(tx, {
            account: PHONE,
            phone: PHONE,
            passwordHash: null,
            passwordAlgo: null,
            nickname: null,
            avatarUrl: null,
            registerSource: 'h5',
            registerIp: null,
            now: harness.clock.now(),
          }),
        ),
      { isWinner: (row) => row !== null },
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    expect(report.losers).toBe(WORKERS - 1);
    expect(await harness.ctx.db.select().from(users)).toHaveLength(1);
  });

  it('six taps on 微信登录 create one account and sign every caller into it', async () => {
    // INVARIANT USER-015, through the public surface. Nobody sees an identity
    // row, so all six create an account and try to claim the openid; the index
    // lets one commit and rolls the other five accounts back with their failed
    // insert. The losers then read the winner's identity and sign in to it —
    // being second must not cost a shopper their sign-in.
    await harness.ctx.config.set(wechatMiniConfig, { enabled: true });
    await harness.ctx.config.set(wechatConfig, { miniAppId: 'wx-app' });
    await harness.ctx.config.set(storefrontAuthConfig, { requirePhoneForWechat: false });
    wechat.setMiniSession('mini-code', { openid: 'o_mini_1' });

    const report = await runConcurrently(WORKERS, (index) =>
      auth.miniLogin(fork(index), { code: 'mini-code' }),
    );

    expect(report.rejected).toEqual([]);
    expect(report.fulfilled).toHaveLength(WORKERS);
    const ids = new Set(report.fulfilled.map((result) => result.session!.user.id));
    expect(ids.size).toBe(1);
    // Exactly one of them registered; the rest joined the account it made.
    expect(report.fulfilled.filter((result) => result.registered)).toHaveLength(1);
    expect(await harness.ctx.db.select().from(users)).toHaveLength(1);
    expect(await harness.ctx.db.select().from(wechatIdentities)).toHaveLength(1);
  });

  it('gives one phone number to one of six accounts binding it at once', async () => {
    // Six different WeChat accounts, one number, one instant. The expression
    // index on `lower(phone)` is the only thing that can settle this; a
    // `SELECT … WHERE phone = ?` in each transaction sees nothing.
    const candidates = await Promise.all(
      Array.from({ length: WORKERS }, () => makeUser({ phone: null })),
    );

    const report = await runConcurrently(
      WORKERS,
      (index) =>
        fork(index).withTx((tx) =>
          repo.bindPhone(tx, {
            id: candidates[index]!.id,
            phone: PHONE,
            alsoSetAccount: false,
            expectPhone: null,
            now: harness.clock.now(),
          }),
        ),
      { isWinner: (result) => result.won },
    );

    // The losers are rejected by the database, not by a guard, so they arrive
    // as errors rather than as `won: false`.
    expect(report.winners + report.rejected.length).toBe(WORKERS);
    expect(report.winners).toBe(1);
    const holders = await harness.ctx.db.select().from(users).where(eq(users.phone, PHONE));
    expect(holders).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

describe('the default address', () => {
  it('leaves exactly one default when six rows are promoted at once', async () => {
    // `user_addresses_default_uq` is a partial unique index over the live
    // default rows. Without it a "clear then set" pair interleaves and the
    // shopper ends up with two defaults — and the checkout picks whichever the
    // planner felt like returning first.
    const user = await makeUser();
    const ctx = harness.as({ kind: 'user', id: user.id, permissions: [], isSuper: false });
    const created: Array<{ id: string }> = [];
    for (let i = 0; i < WORKERS; i += 1) {
      created.push(
        await service.addressCreate(ctx, {
          receiverName: `收货人${i}`,
          receiverPhone: PHONE,
          provinceName: '北京市',
          cityName: '北京市',
          districtName: '朝阳区',
          detail: `建国路 ${i} 号`,
          isDefault: false,
        }),
      );
    }

    const report = await runConcurrently(WORKERS, (index) =>
      service.addressSetDefault(forkUser(index, user.id), { id: created[index]!.id }),
    );

    expect(report.fulfilled.length).toBeGreaterThanOrEqual(1);
    const defaults = await harness.ctx.db
      .select({ id: userAddresses.id })
      .from(userAddresses)
      .where(and(eq(userAddresses.userId, user.id), eq(userAddresses.isDefault, true)));
    expect(defaults).toHaveLength(1);
    // And whichever won is the one the storefront reads back.
    const current = await service.defaultAddress(ctx);
    expect(Number(current.address!.id)).toBe(defaults[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// account cancellation
// ---------------------------------------------------------------------------

describe('account cancellation', () => {
  it('keeps one open request when a customer files six', async () => {
    const user = await makeUser();

    const report = await runConcurrently(WORKERS, (index) =>
      service.requestCancellation(forkUser(index, user.id), { reason: '不想用了' }),
    );

    expect(report.fulfilled).toHaveLength(1);
    for (const failure of codes(report.rejected)) {
      expect(failure).toBe('USER_CANCELLATION_PENDING');
    }
  });

  it('lets exactly one of six approvals anonymise the account', async () => {
    // Two operators working the same queue. The second approval must not run
    // `anonymise` again: it would mint a second `del_…` account name, write a
    // second audit trail and report a session revocation that never happened.
    const user = await makeUser();
    const request = await service.requestCancellation(
      harness.as({ kind: 'user', id: user.id, permissions: [], isSuper: false }),
      { reason: '不想用了' },
    );

    const report = await runConcurrently(WORKERS, (index) =>
      admin.adminApproveCancellation(forkAdmin(index), { id: request.id }, {}),
    );

    expect(report.fulfilled).toHaveLength(1);
    for (const failure of codes(report.rejected)) {
      expect(failure).toBe('USER_CANCELLATION_NOT_PENDING');
    }
    const after = await repo.findById(harness.ctx.db, user.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.account).toMatch(/^del_[0-9a-f]{16}$/);
  });

  it('settles a withdrawal racing an approval one way or the other', async () => {
    // The shopper taps 撤回 as the operator taps 同意. Exactly one of the two
    // changes the row; the loser is told, rather than reporting an outcome the
    // database did not accept.
    const user = await makeUser();
    const userCtx = harness.as({ kind: 'user', id: user.id, permissions: [], isSuper: false });
    const request = await service.requestCancellation(userCtx, { reason: '不想用了' });

    const report = await runConcurrently(2, (index) =>
      index === 0
        ? service.withdrawCancellation(forkUser(index, user.id))
        : admin.adminApproveCancellation(forkAdmin(index), { id: request.id }, {}),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    const settled = report.fulfilled[0]!;
    const after = await repo.findById(harness.ctx.db, user.id);
    // Approval anonymises; a withdrawal leaves the account exactly as it was.
    expect(after!.deletedAt === null).toBe(settled.status === 'withdrawn');
  });
});

// ---------------------------------------------------------------------------
// admin writes
// ---------------------------------------------------------------------------

describe('disabling an account', () => {
  it('bumps the version once and leaves no live session', async () => {
    // INVARIANT USER-012. The guard is `status <> 'disabled'`, so five of the
    // six updates match no row: the version moves by one, not by six. A token
    // minted before the ban stops resolving the instant the version moves,
    // which is what makes a ban take effect now rather than at expiry.
    await auth.sendSmsCode(harness.as(anonymous), { phone: PHONE, scene: 'login' });
    const registered = await auth.smsLogin(harness.as(anonymous), {
      phone: PHONE,
      code: codeOf(PHONE),
    });
    const userId = Number(registered.user.id);
    const before = await repo.findAuthState(harness.ctx.db, userId);
    const sessions = new UserSessionService(30 * 24 * 60 * 60 * 1000);
    expect(await sessions.resolve(harness.ctx, registered.token)).not.toBeNull();

    const report = await runConcurrently(WORKERS, (index) =>
      admin.adminSetStatus(forkAdmin(index), { id: String(userId) }, { status: 'disabled' }),
    );

    expect(report.rejected).toEqual([]);
    for (const detail of report.fulfilled) expect(detail.status).toBe('disabled');
    const after = await repo.findAuthState(harness.ctx.db, userId);
    expect(after!.passwordVersion).toBe(before!.passwordVersion + 1);
    expect(await sessions.resolve(harness.ctx, registered.token)).toBeNull();
  });
});

describe('groups and labels', () => {
  it('lets the unique index settle six identical group creates', async () => {
    const report = await runConcurrently(WORKERS, (index) =>
      admin.groupCreate(forkAdmin(index), { name: '老客户', sortOrder: 0 }),
    );

    expect(report.fulfilled).toHaveLength(1);
    for (const failure of codes(report.rejected)) expect(failure).toBe('USER_GROUP_NAME_TAKEN');
  });

  it('lets the unique index settle six identical label creates', async () => {
    const category = await admin.labelCategoryCreate(forkAdmin(0), {
      name: '偏好',
      sortOrder: 0,
    });

    const report = await runConcurrently(WORKERS, (index) =>
      admin.labelCreate(forkAdmin(index), {
        categoryId: category.id,
        name: '爱买鞋',
        sortOrder: 0,
      }),
    );

    expect(report.fulfilled).toHaveLength(1);
    for (const failure of codes(report.rejected)) expect(failure).toBe('USER_LABEL_NAME_TAKEN');
  });
});
