import type {
  AdminUserCreateBody,
  AdminUserForm,
  UserAddressForm,
} from '@shop/contracts/user/schemas';
import { admins } from '@shop/db/schema/auth';
import { productReviews, products } from '@shop/db/schema/catalog';
import { groupbuyActivities, groupbuyGroups, groupbuyMembers } from '@shop/db/schema/groupbuy';
import { orders } from '@shop/db/schema/order';
import { attachments } from '@shop/db/schema/storage';
import { userAddresses, users } from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as catalog from '../catalog';
import { registerAllDomains } from '../domains.gen';
import { DomainError } from '../kernel/errors';
import type { Actor, Ctx } from '../kernel/context';
import { storefrontAuthConfig } from './storefront-auth.config';
import * as admin from './user-admin.service';
import { onAccountCancelled } from './user-cancelled';
import * as repo from './user.repo';
import * as service from './user.service';

/**
 * The user domain against a real PostgreSQL 17.
 *
 * Everything here needs the database to mean anything: the two expression
 * unique indexes on `lower(account)` / `lower(phone)`, the two partial unique
 * indexes (one live default address, one open cancellation request), and every
 * `conditionalUpdate` whose answer is a row count. The races live next door in
 * `user.concurrency.int.test.ts`; the sign-in flows in
 * `storefront-auth.int.test.ts`.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  // 注销 reaches other domains through the listeners their registrars install,
  // exactly as the app's bootstrap installs them.
  registerAllDomains();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  reviewerId = await makeAdmin();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

function asUser(id: number): Ctx {
  return harness.as(userActor(id));
}

/**
 * A real `admins` row, because `user_cancellation_requests.reviewed_by_admin_id`
 * is a foreign key — an actor id invented in the test passes every assertion in
 * the service and then fails at the database.
 */
let reviewerId = 0;

function asAdmin(): Ctx {
  return harness.as({ kind: 'admin', id: reviewerId, permissions: [], isSuper: true });
}

async function makeAdmin(): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({
      account: `reviewer-${Date.now()}`,
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
  const phone = `1380013${String(8000 + sequence).padStart(4, '0')}`;
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

/**
 * Two shoppers' frozen copies of themselves: reviews (one soft-deleted) on a
 * product that also has an operator's 虚拟评价, and a group-buy team the first
 * one leads and the second one joined. Written directly: the user domain only
 * needs the rows to be there, not the paths that wrote them.
 */
async function makeReviewsAndTeam(
  userId: number,
  otherId: number,
): Promise<{ productId: number; orderId: number }> {
  const db = harness.ctx.db;
  const [product] = await db
    .insert(products)
    .values({
      name: '坚果礼盒',
      imageUrl: '/uploads/p.png',
      status: 'on_shelf',
      freightMode: 'free',
      price: '88.00',
      stock: 100,
    })
    .returning({ id: products.id });
  const productId = product!.id;
  const placeOrder = async (buyer: number) => {
    sequence += 1;
    const [order] = await db
      .insert(orders)
      .values({
        orderNo: `GB${String(sequence).padStart(10, '0')}`,
        userId: buyer,
        platform: 'h5',
        kind: 'groupbuy',
        status: 'pending_payment',
        totalQuantity: 1,
        itemsAmount: '59.00',
        payableAmount: '59.00',
        receiverName: '张三',
        receiverPhone: '13800000000',
        receiverProvince: '广东省',
        receiverCity: '深圳市',
        receiverDetail: '某路 1 号',
      })
      .returning({ id: orders.id });
    return order!.id;
  };
  const orderId = await placeOrder(userId);
  const otherOrderId = await placeOrder(otherId);

  await db.insert(productReviews).values([
    {
      productId,
      userId,
      orderId,
      authorNickname: '要注销的',
      authorAvatarUrl: '/uploads/me.png',
      productScore: 4,
      serviceScore: 5,
      content: '面料很舒服',
    },
    {
      productId,
      userId,
      authorNickname: '要注销的',
      authorAvatarUrl: '/uploads/me.png',
      productScore: 1,
      serviceScore: 1,
      content: '删掉的',
      deletedAt: harness.clock.now(),
    },
    {
      productId,
      userId: otherId,
      authorNickname: '别人',
      authorAvatarUrl: '/uploads/other.png',
      productScore: 5,
      serviceScore: 5,
      content: '还不错',
    },
    {
      productId,
      userId: null,
      authorNickname: '小明',
      authorAvatarUrl: '/uploads/seed.png',
      productScore: 5,
      serviceScore: 5,
      content: '好评',
    },
  ]);

  const [activity] = await db
    .insert(groupbuyActivities)
    .values({
      productId,
      title: '三人成团',
      imageUrl: '/uploads/p.png',
      status: 'active',
      price: '59.00',
      originalPrice: '88.00',
      seatsRequired: 3,
      groupTtlSeconds: 86_400,
      stock: 100,
      perOrderQuantity: 2,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: groupbuyActivities.id });
  const [group] = await db
    .insert(groupbuyGroups)
    .values({
      activityId: activity!.id,
      leaderUserId: userId,
      seatsTotal: 3,
      seatsTaken: 2,
      expiresAt: new Date('2026-06-02T00:00:00.000Z'),
    })
    .returning({ id: groupbuyGroups.id });
  await db.insert(groupbuyMembers).values([
    {
      groupId: group!.id,
      userId,
      orderId,
      role: 'leader',
      nickname: '要注销的',
      avatarUrl: '/uploads/me.png',
      quantity: 2,
    },
    {
      groupId: group!.id,
      userId: otherId,
      orderId: otherOrderId,
      role: 'member',
      nickname: '别人',
      avatarUrl: '/uploads/other.png',
    },
  ]);
  return { productId, orderId };
}

const addressForm = (overrides: Partial<UserAddressForm> = {}): UserAddressForm => ({
  receiverName: '张三',
  receiverPhone: '13800138000',
  provinceName: '北京市',
  cityName: '北京市',
  districtName: '朝阳区',
  detail: '建国路 88 号',
  isDefault: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

describe('account uniqueness', () => {
  it('is case-insensitive on the account name', async () => {
    // INVARIANT USER-014. `users_account_lower_uq` is an expression index; a
    // plain UNIQUE would let `Xiaoming` and `xiaoming` both exist and turn
    // sign-in into a coin flip.
    await makeUser({ account: 'Xiaoming', phone: null });
    const second = await harness.ctx.withTx((tx) =>
      repo.insertUser(tx, {
        account: 'xiaoming',
        phone: null,
        passwordHash: null,
        passwordAlgo: null,
        nickname: null,
        avatarUrl: null,
        registerSource: 'h5',
        registerIp: null,
        now: harness.clock.now(),
      }),
    );
    expect(second).toBeNull();
  });

  it('finds an account whichever case the shopper typed', async () => {
    const created = await makeUser({ account: 'XiaoMing', phone: null });
    const found = await repo.findByAccountOrPhone(harness.ctx.db, '  xIAOmING ');
    expect(found?.id).toBe(created.id);
  });

  it('matches the phone column too, because customers type their number', async () => {
    const created = await makeUser();
    const found = await repo.findByAccountOrPhone(harness.ctx.db, created.phone!);
    expect(found?.id).toBe(created.id);
  });
});

describe('findAuthState', () => {
  it('reports a cancelled account as inactive, not as missing', async () => {
    // `resolve()` refuses on `status !== 1`, so a soft-deleted row must not
    // read as active. Reporting it as *missing* would be equally safe here but
    // makes the admin detail screen lie.
    const user = await makeUser();
    await harness.ctx.withTx((tx) =>
      repo.anonymise(tx, {
        id: user.id,
        account: 'del_0000000000000000',
        now: harness.clock.now(),
      }),
    );
    const state = await repo.findAuthState(harness.ctx.db, user.id);
    expect(state).toMatchObject({ id: user.id, status: 0 });
  });
});

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

describe('profile', () => {
  it('reports whether a password and a WeChat binding exist', async () => {
    const user = await makeUser();
    const profile = await service.getProfile(asUser(user.id));
    expect(profile).toMatchObject({ hasPassword: false, boundWechat: [] });

    await harness.ctx.withTx((tx) =>
      repo.insertIdentity(tx, {
        userId: user.id,
        platform: 'mini',
        openid: 'o_mini_1',
        unionid: null,
        nickname: null,
        avatarUrl: null,
        now: harness.clock.now(),
      }),
    );
    const after = await service.getProfile(asUser(user.id));
    expect(after.boundWechat).toEqual(['mini']);
  });

  it('clears the birthday on an explicit null and leaves it on absence', async () => {
    const user = await makeUser();
    await service.updateProfile(asUser(user.id), { birthday: '2000-05-04T00:00:00+08:00' });
    expect((await service.getProfile(asUser(user.id))).birthday).not.toBeNull();

    await service.updateProfile(asUser(user.id), { nickname: '小明' });
    expect((await service.getProfile(asUser(user.id))).birthday).not.toBeNull();

    await service.updateProfile(asUser(user.id), { birthday: null });
    expect((await service.getProfile(asUser(user.id))).birthday).toBeNull();
  });

  it('refuses to read a cancelled account', async () => {
    const user = await makeUser();
    await harness.ctx.withTx((tx) =>
      repo.anonymise(tx, {
        id: user.id,
        account: 'del_1111111111111111',
        now: harness.clock.now(),
      }),
    );
    await expect(service.getProfile(asUser(user.id))).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
});

describe('USER-019 — the avatar comes from our own storage', () => {
  const STORED = '/uploads/avatar/2026/06/01/0f1e2d3c.png';

  async function storeAttachment(
    url: string,
    overrides: Partial<typeof attachments.$inferInsert> = {},
  ): Promise<void> {
    await harness.ctx.db.insert(attachments).values({
      storageKey: url.replace(/^\/uploads\//, ''),
      driver: 'local',
      url,
      name: 'avatar.png',
      kind: 'image',
      mime: 'image/png',
      size: 26,
      sha256: 'a'.repeat(64),
      ...overrides,
    });
  }

  it('takes an image our uploads stored, whoever uploaded the bytes first', async () => {
    const user = await makeUser();
    await storeAttachment(STORED);
    const profile = await service.updateProfile(asUser(user.id), { avatarUrl: STORED });
    expect(profile.avatarUrl).toBe(STORED);
  });

  it('refuses a URL on somebody else’s server, and changes nothing', async () => {
    const user = await makeUser();
    await expect(
      service.updateProfile(asUser(user.id), {
        nickname: '新名字',
        avatarUrl: 'https://evil.example/pixel.png',
      }),
    ).rejects.toMatchObject({ code: 'USER_AVATAR_NOT_ALLOWED' });
    const profile = await service.getProfile(asUser(user.id));
    expect(profile).toMatchObject({ nickname: user.nickname, avatarUrl: null });
  });

  it('refuses a deleted attachment and one that is not an image', async () => {
    const user = await makeUser();
    await storeAttachment('/uploads/avatar/gone.png', { deletedAt: harness.clock.now() });
    await storeAttachment('/uploads/file/report.pdf', { kind: 'file', mime: 'application/pdf' });
    for (const avatarUrl of ['/uploads/avatar/gone.png', '/uploads/file/report.pdf']) {
      await expect(service.updateProfile(asUser(user.id), { avatarUrl })).rejects.toMatchObject({
        code: 'USER_AVATAR_NOT_ALLOWED',
      });
    }
  });

  it('takes the current avatar back unchanged, as every legacy save re-sends it', async () => {
    const wechatAvatar = 'https://thirdwx.qlogo.cn/mmopen/abc/132';
    const user = await makeUser({ avatarUrl: wechatAvatar });
    const profile = await service.updateProfile(asUser(user.id), {
      nickname: '小明',
      avatarUrl: wechatAvatar,
    });
    expect(profile).toMatchObject({ nickname: '小明', avatarUrl: wechatAvatar });
  });

  it('takes the shop’s default avatar, and clears on an empty string', async () => {
    const fallback = 'https://cdn.example.com/default-avatar.png';
    await harness.ctx.config.set(storefrontAuthConfig, { defaultAvatar: fallback });
    const user = await makeUser();
    expect((await service.updateProfile(asUser(user.id), { avatarUrl: fallback })).avatarUrl).toBe(
      fallback,
    );
    expect((await service.updateProfile(asUser(user.id), { avatarUrl: '' })).avatarUrl).toBeNull();
  });

  it('trims the nickname and refuses one that is only whitespace', async () => {
    const user = await makeUser();
    expect((await service.updateProfile(asUser(user.id), { nickname: ' 小明 ' })).nickname).toBe(
      '小明',
    );
    await expect(service.updateProfile(asUser(user.id), { nickname: '   ' })).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
  });
});

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

describe('addresses', () => {
  it('makes the first one the default whatever the form said', async () => {
    const user = await makeUser();
    const first = await service.addressCreate(asUser(user.id), addressForm({ isDefault: false }));
    expect(first.isDefault).toBe(true);
  });

  it('moves the default rather than ending up with two', async () => {
    const user = await makeUser();
    const first = await service.addressCreate(asUser(user.id), addressForm());
    const second = await service.addressCreate(
      asUser(user.id),
      addressForm({ receiverName: '李四', isDefault: true }),
    );

    expect(second.isDefault).toBe(true);
    const list = await service.addressList(asUser(user.id), { page: 1, pageSize: 20 });
    expect(list.items.filter((a) => a.isDefault)).toHaveLength(1);
    expect(list.items.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });

  it('keeps the default flag when the default address is edited', async () => {
    const user = await makeUser();
    const created = await service.addressCreate(asUser(user.id), addressForm());
    const updated = await service.addressUpdate(
      asUser(user.id),
      { id: created.id },
      addressForm({ detail: '建国路 99 号', isDefault: false }),
    );
    expect(updated.isDefault).toBe(true);
    expect(updated.detail).toBe('建国路 99 号');
  });

  it('never returns another customer’s address', async () => {
    // Every address read carries the owner in the WHERE; an IDOR here is a
    // home address leak.
    const owner = await makeUser();
    const stranger = await makeUser();
    const address = await service.addressCreate(asUser(owner.id), addressForm());

    await expect(
      service.addressDetail(asUser(stranger.id), { id: address.id }),
    ).rejects.toMatchObject({ code: 'USER_ADDRESS_NOT_FOUND' });
    await expect(
      service.addressDelete(asUser(stranger.id), { id: address.id }),
    ).rejects.toMatchObject({ code: 'USER_ADDRESS_NOT_FOUND' });
  });

  it('soft-deletes, frees the default slot, and stops listing it', async () => {
    const user = await makeUser();
    const created = await service.addressCreate(asUser(user.id), addressForm());
    await service.addressDelete(asUser(user.id), { id: created.id });

    expect(await service.defaultAddress(asUser(user.id))).toEqual({ address: null });
    expect((await service.addressList(asUser(user.id), { page: 1, pageSize: 20 })).total).toBe(0);
    // A second address may now take the default slot: the partial unique index
    // is `where is_default and deleted_at is null`.
    const replacement = await service.addressCreate(asUser(user.id), addressForm());
    expect(replacement.isDefault).toBe(true);
  });

  it('USER-020: deleting the default makes the newest of the rest the default', async () => {
    const user = await makeUser();
    const oldest = await service.addressCreate(asUser(user.id), addressForm());
    const newest = await service.addressCreate(
      asUser(user.id),
      addressForm({ receiverName: '李四', isDefault: false }),
    );
    const chosen = await service.addressCreate(
      asUser(user.id),
      addressForm({ receiverName: '王五', isDefault: true }),
    );
    // `chosen` is newer still, but it is the one going away.
    await service.addressDelete(asUser(user.id), { id: chosen.id });

    const { address } = await service.defaultAddress(asUser(user.id));
    expect(address?.id).not.toBe(oldest.id);
    expect(address?.id).toBe(newest.id);
    const list = await service.addressList(asUser(user.id), { page: 1, pageSize: 20 });
    expect(list.items.filter((a) => a.isDefault)).toHaveLength(1);
  });

  it('USER-020: deleting another address leaves the default where it is', async () => {
    const user = await makeUser();
    const home = await service.addressCreate(asUser(user.id), addressForm());
    const office = await service.addressCreate(asUser(user.id), addressForm({ isDefault: false }));
    await service.addressDelete(asUser(user.id), { id: office.id });
    expect((await service.defaultAddress(asUser(user.id))).address?.id).toBe(home.id);
  });

  it('enforces the configured limit', async () => {
    const user = await makeUser();
    await harness.ctx.config.set(storefrontAuthConfig, { addressLimit: 2 });
    await service.addressCreate(asUser(user.id), addressForm());
    await service.addressCreate(asUser(user.id), addressForm());
    await expect(service.addressCreate(asUser(user.id), addressForm())).rejects.toMatchObject({
      code: 'USER_ADDRESS_LIMIT_REACHED',
    });
  });
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

describe('account cancellation', () => {
  it('allows only one open request per customer', async () => {
    const user = await makeUser();
    await service.requestCancellation(asUser(user.id), { reason: '不再使用了' });
    await expect(service.requestCancellation(asUser(user.id), {})).rejects.toMatchObject({
      code: 'USER_CANCELLATION_PENDING',
    });
  });

  it('lets a customer withdraw and then ask again', async () => {
    const user = await makeUser();
    await service.requestCancellation(asUser(user.id), {});
    const withdrawn = await service.withdrawCancellation(asUser(user.id));
    expect(withdrawn.status).toBe('withdrawn');
    expect(await service.currentCancellation(asUser(user.id))).toEqual({ request: null });
    await expect(service.requestCancellation(asUser(user.id), {})).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('freezes the nickname and phone so the reviewer still sees a person', async () => {
    const user = await makeUser();
    const request = await service.requestCancellation(asUser(user.id), {});
    await admin.adminApproveCancellation(asAdmin(), { id: request.id }, {});
    const after = await repo.findCancellation(harness.ctx.db, Number(request.id));
    expect(after).toMatchObject({ nickname: user.nickname, phone: user.phone });
  });

  it('anonymises on approval and never deletes the row', async () => {
    const user = await makeUser();
    const request = await service.requestCancellation(asUser(user.id), {});
    const decided = await admin.adminApproveCancellation(
      asAdmin(),
      { id: request.id },
      { remark: '已核对无未完成订单' },
    );
    expect(decided.status).toBe('approved');

    const [row] = await harness.ctx.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.phone).toBeNull();
    expect(row!.nickname).toBeNull();
    expect(row!.passwordHash).toBeNull();
    expect(row!.status).toBe('disabled');
    // The old account name must stop occupying `users_account_lower_uq`, so
    // the same person can register again tomorrow.
    expect(row!.account).toMatch(/^del_[0-9a-f]{16}$/);
    expect(row!.passwordVersion).toBeGreaterThan(user.passwordVersion);
  });

  /**
   * 注销 has to let go of the WeChat identity — otherwise the same openid finds
   * the anonymised row on its next sign-in and is refused as disabled forever —
   * and has to take the address book with it, which is personal data too.
   */
  it('releases the WeChat identities and deletes the address book', async () => {
    const user = await makeUser();
    await harness.ctx.db.insert(wechatIdentities).values([
      { userId: user.id, platform: 'mini', openid: `o-mini-${user.id}` },
      { userId: user.id, platform: 'oa', openid: `o-oa-${user.id}` },
    ]);
    await harness.ctx.db.insert(userAddresses).values({
      userId: user.id,
      receiverName: '张三',
      receiverPhone: '13800000000',
      provinceName: '广东省',
      cityName: '深圳市',
      detail: '某路 1 号',
    });
    const other = await makeUser();
    await harness.ctx.db
      .insert(wechatIdentities)
      .values({ userId: other.id, platform: 'mini', openid: `o-mini-${other.id}` });

    const request = await service.requestCancellation(asUser(user.id), {});
    await admin.adminApproveCancellation(asAdmin(), { id: request.id }, {});

    expect(
      await harness.ctx.db
        .select()
        .from(wechatIdentities)
        .where(eq(wechatIdentities.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.ctx.db.select().from(userAddresses).where(eq(userAddresses.userId, user.id)),
    ).toEqual([]);
    // Nobody else's identity goes with it.
    expect(
      await harness.ctx.db
        .select()
        .from(wechatIdentities)
        .where(eq(wechatIdentities.userId, other.id)),
    ).toHaveLength(1);
  });

  /**
   * A review and a group-buy seat outlive the account — the score is part of the
   * product's, the seat is part of somebody else's team — but neither may still
   * say whose they were. Everybody else's copies stay as they are.
   */
  it('keeps reviews and group-buy seats, without the nickname or avatar', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const world = await makeReviewsAndTeam(user.id, other.id);

    const request = await service.requestCancellation(asUser(user.id), {});
    await admin.adminApproveCancellation(asAdmin(), { id: request.id }, {});

    const reviews = await harness.ctx.db
      .select()
      .from(productReviews)
      .orderBy(asc(productReviews.id));
    expect(reviews.map((r) => [r.userId, r.authorNickname, r.authorAvatarUrl, r.content])).toEqual([
      [user.id, null, null, '面料很舒服'],
      // Soft-deleted is not forgotten.
      [user.id, null, null, '删掉的'],
      [other.id, '别人', '/uploads/other.png', '还不错'],
      // An operator's 虚拟评价 has no user and keeps the name it was given.
      [null, '小明', '/uploads/seed.png', '好评'],
    ]);
    expect(reviews[0]).toMatchObject({
      productScore: 4,
      orderId: world.orderId,
      status: 'published',
    });

    const members = await harness.ctx.db
      .select()
      .from(groupbuyMembers)
      .orderBy(asc(groupbuyMembers.id));
    expect(members.map((m) => [m.userId, m.nickname, m.avatarUrl])).toEqual([
      [user.id, null, null],
      [other.id, '别人', '/uploads/other.png'],
    ]);
    expect(members[0]).toMatchObject({
      role: 'leader',
      status: 'joined',
      orderId: world.orderId,
      quantity: 2,
    });

    // What the storefront is handed: the review, as 匿名用户 with the default avatar.
    const shown = await catalog.productReviews(
      harness.ctx,
      { id: String(world.productId) },
      { rating: 'all', page: 1, pageSize: 20 },
    );
    expect(shown.items.find((r) => r.content === '面料很舒服')).toMatchObject({
      authorNickname: null,
      authorAvatarUrl: null,
    });
  });

  it('approves nothing when a domain cannot forget the account', async () => {
    const user = await makeUser();
    const request = await service.requestCancellation(asUser(user.id), {});
    onAccountCancelled('test-refuses', async () => {
      throw new Error('boom');
    });
    try {
      await expect(
        admin.adminApproveCancellation(asAdmin(), { id: request.id }, {}),
      ).rejects.toThrow('boom');
    } finally {
      onAccountCancelled('test-refuses', async () => {});
    }

    expect(await repo.findCancellation(harness.ctx.db, Number(request.id))).toMatchObject({
      status: 'pending',
    });
    const [row] = await harness.ctx.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ deletedAt: null, nickname: user.nickname });
  });

  it('frees the phone number for a fresh registration', async () => {
    const user = await makeUser();
    const phone = user.phone!;
    const request = await service.requestCancellation(asUser(user.id), {});
    await admin.adminApproveCancellation(asAdmin(), { id: request.id }, {});

    const reborn = await harness.ctx.withTx((tx) =>
      repo.insertUser(tx, {
        account: phone,
        phone,
        passwordHash: null,
        passwordAlgo: null,
        nickname: null,
        avatarUrl: null,
        registerSource: 'h5',
        registerIp: null,
        now: harness.clock.now(),
      }),
    );
    expect(reborn).not.toBeNull();
    expect(reborn!.id).not.toBe(user.id);
  });

  it('refuses to decide a request that is no longer pending', async () => {
    const user = await makeUser();
    const request = await service.requestCancellation(asUser(user.id), {});
    await admin.adminApproveCancellation(asAdmin(), { id: request.id }, {});
    await expect(
      admin.adminRejectCancellation(asAdmin(), { id: request.id }, {}),
    ).rejects.toMatchObject({ code: 'USER_CANCELLATION_NOT_PENDING' });
  });
});

// ---------------------------------------------------------------------------
// admin: list, edit, status
// ---------------------------------------------------------------------------

describe('admin list', () => {
  it('masks the phone number in the list and not in the detail', async () => {
    const user = await makeUser({ account: '13800138111', phone: '13800138111' });
    const list = await admin.adminList(asAdmin(), { page: 1, pageSize: 20 });
    expect(list.items[0]?.phone).toBe('138****8111');

    const detail = await admin.adminDetail(asAdmin(), { id: String(user.id) });
    expect(detail.phone).toBe('13800138111');
  });

  it('filters by keyword, status, source and WeChat binding', async () => {
    const plain = await makeUser({ nickname: '小明' });
    const bound = await makeUser({ nickname: '小红', registerSource: 'wechat_mini' });
    await harness.ctx.withTx((tx) =>
      repo.insertIdentity(tx, {
        userId: bound.id,
        platform: 'mini',
        openid: 'o_filter',
        unionid: null,
        nickname: null,
        avatarUrl: null,
        now: harness.clock.now(),
      }),
    );

    const byKeyword = await admin.adminList(asAdmin(), { page: 1, pageSize: 20, keyword: '小红' });
    expect(byKeyword.items.map((u) => u.id)).toEqual([String(bound.id)]);

    const withWechat = await admin.adminList(asAdmin(), { page: 1, pageSize: 20, hasWechat: true });
    expect(withWechat.items.map((u) => u.id)).toEqual([String(bound.id)]);

    const withoutWechat = await admin.adminList(asAdmin(), {
      page: 1,
      pageSize: 20,
      hasWechat: false,
    });
    expect(withoutWechat.items.map((u) => u.id)).toEqual([String(plain.id)]);

    const bySource = await admin.adminList(asAdmin(), {
      page: 1,
      pageSize: 20,
      registerSource: 'wechat_mini',
    });
    expect(bySource.total).toBe(1);
  });

  it('hides cancelled accounts from the list', async () => {
    const user = await makeUser();
    await harness.ctx.withTx((tx) =>
      repo.anonymise(tx, {
        id: user.id,
        account: 'del_2222222222222222',
        now: harness.clock.now(),
      }),
    );
    expect((await admin.adminList(asAdmin(), { page: 1, pageSize: 20 })).total).toBe(0);
  });
});

describe('admin edit', () => {
  const form = (overrides: Partial<AdminUserForm> = {}): AdminUserForm => ({
    groupIds: [],
    labelIds: [],
    ...overrides,
  });

  it('replaces group and label membership rather than adding to it', async () => {
    const user = await makeUser();
    const vip = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    const lapsed = await admin.groupCreate(asAdmin(), { name: '沉睡', sortOrder: 1 });

    await admin.adminUpdate(asAdmin(), { id: String(user.id) }, form({ groupIds: [vip.id] }));
    await admin.adminUpdate(asAdmin(), { id: String(user.id) }, form({ groupIds: [lapsed.id] }));

    const detail = await admin.adminDetail(asAdmin(), { id: String(user.id) });
    expect(detail.groups.map((g) => g.id)).toEqual([lapsed.id]);
  });

  it('refuses a group id that does not exist rather than silently dropping it', async () => {
    const user = await makeUser();
    await expect(
      admin.adminUpdate(asAdmin(), { id: String(user.id) }, form({ groupIds: ['999999'] })),
    ).rejects.toMatchObject({ code: 'USER_GROUP_NOT_FOUND' });
  });
});

describe('admin create', () => {
  const body = (overrides: Partial<AdminUserCreateBody> = {}): AdminUserCreateBody => ({
    phone: '13900139000',
    groupIds: [],
    labelIds: [],
    ...overrides,
  });

  it('opens an account whose login is the phone, marked 后台录入', async () => {
    const vip = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    const created = await admin.adminCreate(
      asAdmin(),
      body({ realName: '王五', adminRemark: '电话下单', groupIds: [vip.id] }),
    );

    expect(created).toMatchObject({
      account: '13900139000',
      phone: '13900139000',
      realName: '王五',
      adminRemark: '电话下单',
      registerSource: 'admin',
      status: 'active',
    });
    expect(created.nickname).toBeTruthy();
    expect(created.groups.map((g) => g.id)).toEqual([vip.id]);
    // No password given: SMS or WeChat only.
    expect((await repo.findById(harness.ctx.db, Number(created.id)))!.passwordHash).toBeNull();
  });

  it('is the account an SMS login with that phone finds later', async () => {
    const created = await admin.adminCreate(asAdmin(), body({ password: 'abc12345' }));
    const found = await repo.findByPhone(harness.ctx.db, '13900139000');
    expect(found!.id).toBe(Number(created.id));
    expect(found!.passwordAlgo).toBe('bcrypt');
  });

  it('refuses a phone another account already holds, and writes nothing', async () => {
    const taken = await makeUser();
    await expect(admin.adminCreate(asAdmin(), body({ phone: taken.phone! }))).rejects.toMatchObject(
      { code: 'USER_PHONE_TAKEN' },
    );
    expect(await harness.ctx.db.select().from(users)).toHaveLength(1);
  });

  it('rolls back the account when a group does not exist', async () => {
    await expect(
      admin.adminCreate(asAdmin(), body({ groupIds: ['999999'] })),
    ).rejects.toMatchObject({ code: 'USER_GROUP_NOT_FOUND' });
    expect(await repo.findByPhone(harness.ctx.db, '13900139000')).toBeNull();
  });

  it('rejects a weak password before writing anything', async () => {
    await expect(admin.adminCreate(asAdmin(), body({ password: '123456' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await repo.findByPhone(harness.ctx.db, '13900139000')).toBeNull();
  });
});

describe('admin status and password', () => {
  it('bumps the password version when disabling, so live tokens die', async () => {
    const user = await makeUser();
    await admin.adminSetStatus(asAdmin(), { id: String(user.id) }, { status: 'disabled' });
    const after = await repo.findById(harness.ctx.db, user.id);
    expect(after!.status).toBe('disabled');
    expect(after!.passwordVersion).toBe(user.passwordVersion + 1);
    expect(await repo.findAuthState(harness.ctx.db, user.id)).toMatchObject({ status: 0 });
  });

  it('is idempotent on a status that is already set', async () => {
    const user = await makeUser();
    await admin.adminSetStatus(asAdmin(), { id: String(user.id) }, { status: 'disabled' });
    const once = await repo.findById(harness.ctx.db, user.id);
    await admin.adminSetStatus(asAdmin(), { id: String(user.id) }, { status: 'disabled' });
    const twice = await repo.findById(harness.ctx.db, user.id);
    expect(twice!.passwordVersion).toBe(once!.passwordVersion);
  });

  it('rejects a weak operator-set password before hashing it', async () => {
    const user = await makeUser();
    await expect(
      admin.adminResetPassword(asAdmin(), { id: String(user.id) }, { password: '123456' }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe('admin batch membership', () => {
  it('refuses the whole batch when a target id is unknown', async () => {
    // Skipping the unknown ids silently is how an operator comes to believe
    // 500 customers were tagged when 3 were.
    const user = await makeUser();
    const group = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    await expect(
      admin.adminBatchSetGroups(asAdmin(), {
        userIds: [String(user.id), '999999'],
        groupIds: [group.id],
        mode: 'add',
      }),
    ).rejects.toMatchObject({ code: 'USER_BATCH_TARGET_UNKNOWN' });
  });

  it('adds, removes and replaces', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const vip = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    const lapsed = await admin.groupCreate(asAdmin(), { name: '沉睡', sortOrder: 1 });
    const ids = [String(a.id), String(b.id)];

    const added = await admin.adminBatchSetGroups(asAdmin(), {
      userIds: ids,
      groupIds: [vip.id, lapsed.id],
      mode: 'add',
    });
    expect(added.affected).toBe(2);

    await admin.adminBatchSetGroups(asAdmin(), {
      userIds: ids,
      groupIds: [lapsed.id],
      mode: 'remove',
    });
    expect((await admin.adminDetail(asAdmin(), { id: String(a.id) })).groups).toHaveLength(1);

    await admin.adminBatchSetGroups(asAdmin(), { userIds: ids, groupIds: [], mode: 'replace' });
    expect((await admin.adminDetail(asAdmin(), { id: String(a.id) })).groups).toHaveLength(0);
  });

  it('is repeatable — adding the same group twice is one membership', async () => {
    const user = await makeUser();
    const vip = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    await admin.adminBatchSetGroups(asAdmin(), {
      userIds: [String(user.id)],
      groupIds: [vip.id],
      mode: 'add',
    });
    await admin.adminBatchSetGroups(asAdmin(), {
      userIds: [String(user.id)],
      groupIds: [vip.id],
      mode: 'add',
    });
    expect((await admin.adminDetail(asAdmin(), { id: String(user.id) })).groups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// taxonomy
// ---------------------------------------------------------------------------

describe('groups and labels', () => {
  it('refuses a duplicate name on create and on rename', async () => {
    await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    await expect(admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 })).rejects.toMatchObject(
      {
        code: 'USER_GROUP_NAME_TAKEN',
      },
    );

    const other = await admin.groupCreate(asAdmin(), { name: '沉睡', sortOrder: 1 });
    await expect(
      admin.groupUpdate(asAdmin(), { id: other.id }, { name: 'VIP', sortOrder: 1 }),
    ).rejects.toMatchObject({ code: 'USER_GROUP_NAME_TAKEN' });
  });

  it('counts members', async () => {
    const user = await makeUser();
    const group = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    await admin.adminBatchSetGroups(asAdmin(), {
      userIds: [String(user.id)],
      groupIds: [group.id],
      mode: 'add',
    });
    const list = await admin.groupList(asAdmin(), { page: 1, pageSize: 20 });
    expect(list.items[0]?.memberCount).toBe(1);
  });

  it('takes the memberships with the group and leaves the customers', async () => {
    const user = await makeUser();
    const group = await admin.groupCreate(asAdmin(), { name: 'VIP', sortOrder: 0 });
    await admin.adminBatchSetGroups(asAdmin(), {
      userIds: [String(user.id)],
      groupIds: [group.id],
      mode: 'add',
    });
    await admin.groupDelete(asAdmin(), { id: group.id });
    expect(await repo.findById(harness.ctx.db, user.id)).not.toBeNull();
    expect((await admin.adminDetail(asAdmin(), { id: String(user.id) })).groups).toHaveLength(0);
  });

  it('keeps labels when their category is deleted', async () => {
    const category = await admin.labelCategoryCreate(asAdmin(), { name: '消费偏好', sortOrder: 0 });
    const label = await admin.labelCreate(asAdmin(), {
      categoryId: category.id,
      name: '母婴',
      sortOrder: 0,
    });
    await admin.labelCategoryDelete(asAdmin(), { id: category.id });
    const after = await admin.labelList(asAdmin(), { page: 1, pageSize: 20 });
    expect(after.items.map((l) => l.id)).toEqual([label.id]);
    expect(after.items[0]?.categoryId).toBeNull();
  });

  it('refuses a label pointed at a category that does not exist', async () => {
    await expect(
      admin.labelCreate(asAdmin(), { categoryId: '999999', name: '母婴', sortOrder: 0 }),
    ).rejects.toMatchObject({ code: 'USER_LABEL_CATEGORY_NOT_FOUND' });
  });

  it('reports a missing row rather than a silent no-op on delete', async () => {
    await expect(admin.groupDelete(asAdmin(), { id: '999999' })).rejects.toMatchObject({
      code: 'USER_GROUP_NOT_FOUND',
    });
    await expect(admin.labelDelete(asAdmin(), { id: '999999' })).rejects.toMatchObject({
      code: 'USER_LABEL_NOT_FOUND',
    });
  });
});
