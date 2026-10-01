import type { PageQuery } from '@shop/contracts/conventions';
import type {
  CancellationRequest,
  CancellationRequestForm,
  UserAddress,
  UserAddressForm,
  UserProfile,
  UserProfileForm,
} from '@shop/contracts/user/schemas';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import { isStoredImageUrl } from '../storage';
import { checkText, requestMediaCheck } from '../wechat';
import { storefrontAuthConfig } from './storefront-auth.config';
import { pageBounds, shouldForceDefault } from './user.rules';
import * as repo from './user.repo';

/**
 * What a signed-in shopper can do to their own account: read and edit the
 * profile, keep a book of delivery addresses, and ask for the account to be
 * closed.
 *
 * Everything here is scoped to `requireUserId(ctx)`. There is no service in
 * this file that takes a user id as an argument — an IDOR in the address book
 * is a home address leak, and the shape of the code is the defence.
 */

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

export async function getProfile(ctx: Ctx): Promise<UserProfile> {
  const userId = requireUserId(ctx);
  const row = await repo.findById(ctx.db, userId);
  if (!row || row.deletedAt !== null) throw new DomainError('USER_NOT_FOUND');
  const platforms = await repo.listPlatformsForUser(ctx.db, userId);
  return toProfile(row, platforms);
}

export async function updateProfile(ctx: Ctx, body: UserProfileForm): Promise<UserProfile> {
  const userId = requireUserId(ctx);
  const nickname = body.nickname === undefined ? undefined : body.nickname.trim();
  if (nickname === '') {
    throw new DomainError('VALIDATION_FAILED', {
      details: [{ field: 'body.nickname', message: '昵称不能为空' }],
    });
  }
  const before = await repo.findById(ctx.db, userId);
  if (!before || before.deletedAt !== null) throw new DomainError('USER_NOT_FOUND');
  // 内容安全 (C09, CONTENT-002): a changed nickname goes to WeChat first. Only
  // `risky` refuses it; WeChat being unreachable lets it through (fail-open).
  if (nickname !== undefined && nickname !== before.nickname) {
    const verdict = await checkText(ctx, { userId, content: nickname, scene: 1, what: 'nickname' });
    if (verdict === 'risky') throw new DomainError('USER_NICKNAME_REJECTED');
  }
  const avatarUrl =
    body.avatarUrl === undefined ? undefined : await acceptedAvatar(ctx, userId, body.avatarUrl);
  const { defaultAvatar } = await ctx.config.get(storefrontAuthConfig);
  const avatarToCheck =
    avatarUrl !== undefined &&
    avatarUrl !== null &&
    avatarUrl !== before.avatarUrl &&
    avatarUrl !== defaultAvatar.trim()
      ? avatarUrl
      : null;
  await ctx.withTx(async (tx) => {
    const result = await repo.updateProfile(tx, {
      id: userId,
      ...(nickname === undefined ? {} : { nickname }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(body.realName === undefined ? {} : { realName: body.realName }),
      // `nullish` in the form: `null` clears the birthday, absent leaves it.
      ...(body.birthday === undefined
        ? {}
        : { birthday: body.birthday === null ? null : new Date(body.birthday) }),
      now: ctx.clock.now(),
    });
    if (!result.won) throw new DomainError('USER_NOT_FOUND');
    // A new picture is checked after the fact, by push (CONTENT-004).
    if (avatarToCheck !== null) {
      await requestMediaCheck(tx, ctx, {
        subject: 'avatar',
        subjectId: userId,
        userId,
        mediaUrl: avatarToCheck,
        scene: 1,
      });
    }
  });
  return getProfile(ctx);
}

/**
 * The avatar to store, or `USER_AVATAR_NOT_ALLOWED` (USER-019).
 *
 * An avatar is shown next to every review and in the admin console, so it has
 * to be a picture we hold, not a link to somebody else's server — which could
 * change what it shows after the fact, or log who looked. Three things pass:
 *
 * 1. the current value — the legacy client re-sends the avatar on every save,
 *    and an account that came in through the 公众号 carries WeChat's URL;
 * 2. the shop's configured default avatar;
 * 3. a live image in our storage (what `POST /uploads` returned).
 *
 * `''` clears the avatar.
 */
async function acceptedAvatar(ctx: Ctx, userId: number, url: string): Promise<string | null> {
  const wanted = url.trim();
  if (wanted === '') return null;
  const current = await repo.findById(ctx.db, userId);
  if (!current || current.deletedAt !== null) throw new DomainError('USER_NOT_FOUND');
  if (current.avatarUrl !== null && wanted === current.avatarUrl) return wanted;
  const config = await ctx.config.get(storefrontAuthConfig);
  const fallback = config.defaultAvatar.trim();
  if (fallback !== '' && wanted === fallback) return wanted;
  if (await isStoredImageUrl(ctx, wanted)) return wanted;
  throw new DomainError('USER_AVATAR_NOT_ALLOWED');
}

/**
 * The profile as the wire sees it.
 *
 * `hasPassword` rather than any part of the hash, and `boundWechat` as a list
 * of platforms rather than openids: an openid is a stable cross-app identifier
 * and the storefront has no use for one.
 */
export function toProfile(row: repo.UserRow, platforms: Array<'oa' | 'mini'>): UserProfile {
  return {
    id: toId(row.id),
    account: row.account,
    phone: row.phone,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    realName: row.realName,
    birthday: iso(row.birthday),
    registerSource: row.registerSource,
    hasPassword: row.passwordHash !== null,
    boundWechat: platforms,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

export async function addressList(
  ctx: Ctx,
  query: PageQuery,
): Promise<{ items: UserAddress[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const [rows, total] = await Promise.all([
    repo.listAddresses(ctx.db, { userId, ...pageBounds(query) }),
    repo.countAddresses(ctx.db, userId),
  ]);
  return { items: rows.map(toAddress), total, page: query.page, pageSize: query.pageSize };
}

/**
 * The address checkout preselects.
 *
 * Returns `null` rather than 404 when there is none: "this customer has not
 * saved an address yet" is an ordinary state of a new account, and making the
 * client treat it as an error leaves the checkout with a blank delivery card.
 */
export async function defaultAddress(ctx: Ctx): Promise<{ address: UserAddress | null }> {
  const userId = requireUserId(ctx);
  const row = await repo.findDefaultAddress(ctx.db, userId);
  // Wrapped, not bare: a bare `null` body is indistinguishable from an empty
  // response, and the contract's envelope leaves room to add to it later.
  return { address: row ? toAddress(row) : null };
}

export async function addressDetail(ctx: Ctx, params: { id: string }): Promise<UserAddress> {
  const userId = requireUserId(ctx);
  const row = await repo.findAddress(ctx.db, { id: fromId(params.id), userId });
  if (!row) throw new DomainError('USER_ADDRESS_NOT_FOUND');
  return toAddress(row);
}

export async function addressCreate(ctx: Ctx, body: UserAddressForm): Promise<UserAddress> {
  const userId = requireUserId(ctx);
  const config = await ctx.config.get(storefrontAuthConfig);
  return ctx.withTx(async (tx) => {
    const existing = await repo.countAddresses(tx, userId);
    if (existing >= config.addressLimit) {
      throw new DomainError('USER_ADDRESS_LIMIT_REACHED', {
        details: { limit: config.addressLimit },
      });
    }
    const now = ctx.clock.now();
    const isDefault = shouldForceDefault(existing, body.isDefault);
    // Clear first: `user_addresses_default_uq` is a partial unique index, so
    // inserting a second default before clearing the old one is a constraint
    // violation rather than a replacement.
    if (isDefault) await repo.clearDefaultAddress(tx, { userId, now });
    const row = await repo.insertAddress(tx, {
      userId,
      ...addressValues(body),
      isDefault,
      now,
    });
    return toAddress(row);
  });
}

export async function addressUpdate(
  ctx: Ctx,
  params: { id: string },
  body: UserAddressForm,
): Promise<UserAddress> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  return ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    const current = await repo.findAddress(tx, { id, userId });
    if (!current) throw new DomainError('USER_ADDRESS_NOT_FOUND');
    // Editing the address that already is the default must not clear the flag.
    const isDefault = body.isDefault || current.isDefault;
    if (isDefault) await repo.clearDefaultAddress(tx, { userId, exceptId: id, now });
    const result = await repo.updateAddress(tx, {
      id,
      userId,
      ...addressValues(body),
      isDefault,
      now,
    });
    if (!result.won) throw new DomainError('USER_ADDRESS_NOT_FOUND');
    const row = await repo.findAddress(tx, { id, userId });
    if (!row) throw new DomainError('USER_ADDRESS_NOT_FOUND');
    return toAddress(row);
  });
}

/**
 * Soft delete.
 *
 * Orders reference the address they were shipped to through a frozen snapshot,
 * not this row, so nothing breaks — but a customer who deletes an address and
 * then asks "where did you send it" deserves an answer, and `deleted_at` keeps
 * one.
 *
 * Deleting the default makes the most recently added of the rest the default
 * (USER-020): checkout preselects the default, and a book of addresses with
 * none marked would leave 确认订单 asking for an address the shopper has.
 */
export async function addressDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    await repo.lockAddressBook(tx, userId);
    const current = await repo.findAddress(tx, { id, userId });
    const result = await repo.softDeleteAddress(tx, { id, userId, now });
    if (!result.won) throw new DomainError('USER_ADDRESS_NOT_FOUND');
    if (!current?.isDefault) return;
    // Default first, then newest: with the default gone, the newest of the rest.
    const [next] = await repo.listAddresses(tx, { userId, limit: 1, offset: 0 });
    if (next && !next.isDefault) await repo.setDefaultAddress(tx, { id: next.id, userId, now });
  });
}

export async function addressSetDefault(ctx: Ctx, params: { id: string }): Promise<UserAddress> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  return ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    await repo.clearDefaultAddress(tx, { userId, exceptId: id, now });
    const result = await repo.setDefaultAddress(tx, { id, userId, now });
    if (!result.won) throw new DomainError('USER_ADDRESS_NOT_FOUND');
    const row = await repo.findAddress(tx, { id, userId });
    if (!row) throw new DomainError('USER_ADDRESS_NOT_FOUND');
    return toAddress(row);
  });
}

function addressValues(body: UserAddressForm): repo.AddressInput {
  return {
    receiverName: body.receiverName,
    receiverPhone: body.receiverPhone,
    provinceId: body.provinceId === undefined ? null : fromId(body.provinceId),
    cityId: body.cityId === undefined ? null : fromId(body.cityId),
    districtId: body.districtId === undefined ? null : fromId(body.districtId),
    provinceName: body.provinceName,
    cityName: body.cityName,
    districtName: body.districtName ?? null,
    detail: body.detail,
    postCode: body.postCode ?? null,
    lng: body.lng ?? null,
    lat: body.lat ?? null,
    isDefault: body.isDefault,
  };
}

function toAddress(row: repo.AddressRow): UserAddress {
  return {
    id: toId(row.id),
    receiverName: row.receiverName,
    receiverPhone: row.receiverPhone,
    provinceId: toIdOrNull(row.provinceId),
    cityId: toIdOrNull(row.cityId),
    districtId: toIdOrNull(row.districtId),
    provinceName: row.provinceName,
    cityName: row.cityName,
    districtName: row.districtName,
    detail: row.detail,
    postCode: row.postCode,
    lng: row.lng,
    lat: row.lat,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// account cancellation
// ---------------------------------------------------------------------------

/**
 * File a 注销申请.
 *
 * It does **not** close the account. Somebody with an unshipped order, a
 * pending refund or an unspent balance who taps 注销 by accident must not be
 * able to destroy their own evidence, so the request goes to an operator, and
 * the account keeps working until it is approved.
 *
 * The nickname and phone are copied onto the request because approval wipes
 * them from `users`, and a reviewer looking at the list afterwards would
 * otherwise see nothing but an id.
 */
export async function requestCancellation(
  ctx: Ctx,
  body: CancellationRequestForm,
): Promise<CancellationRequest> {
  const userId = requireUserId(ctx);
  return ctx.withTx(async (tx) => {
    const user = await repo.findById(tx, userId);
    if (!user || user.deletedAt !== null) throw new DomainError('USER_NOT_FOUND');
    const row = await repo.insertCancellation(tx, {
      userId,
      nickname: user.nickname,
      phone: user.phone,
      reason: body.reason ?? null,
      now: ctx.clock.now(),
    });
    // `null` means `user_cancellation_requests_open_uq` refused it: one open
    // request per customer, decided by the index rather than by a prior read.
    if (!row) throw new DomainError('USER_CANCELLATION_PENDING');
    return toCancellation(row);
  });
}

export async function currentCancellation(
  ctx: Ctx,
): Promise<{ request: CancellationRequest | null }> {
  const userId = requireUserId(ctx);
  const row = await repo.findPendingCancellation(ctx.db, userId);
  return { request: row ? toCancellation(row) : null };
}

export async function withdrawCancellation(ctx: Ctx): Promise<CancellationRequest> {
  const userId = requireUserId(ctx);
  return ctx.withTx(async (tx) => {
    const row = await repo.findPendingCancellation(tx, userId);
    if (!row) throw new DomainError('USER_CANCELLATION_NOT_FOUND');
    const result = await repo.decideCancellation(tx, {
      id: row.id,
      status: 'withdrawn',
      adminId: null,
      remark: null,
      now: ctx.clock.now(),
    });
    // Lost to an operator who approved it in the same instant. Say so rather
    // than reporting a withdrawal that did not happen.
    if (!result.won) throw new DomainError('USER_CANCELLATION_NOT_PENDING');
    const after = await repo.findCancellation(tx, row.id);
    if (!after) throw new DomainError('USER_CANCELLATION_NOT_FOUND');
    return toCancellation(after);
  });
}

export function toCancellation(row: repo.CancellationRow): CancellationRequest {
  return {
    id: toId(row.id),
    userId: toId(row.userId),
    nickname: row.nickname,
    phone: row.phone,
    reason: row.reason,
    status: row.status,
    reviewRemark: row.reviewRemark,
    reviewedAt: iso(row.reviewedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
