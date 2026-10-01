import type {
  AdminUserBatchGroupBody,
  AdminUserBatchLabelBody,
  AdminUserCreateBody,
  AdminUserDetail,
  AdminUserForm,
  AdminUserListItem,
  AdminUserListQuery,
  AdminUserPasswordBody,
  AdminUserStatusBody,
  BatchResult,
  CancellationListQuery,
  CancellationRemarkBody,
  CancellationRequest,
  CancellationReviewBody,
  NamedRef,
  UserAddress,
  UserGroup,
  UserGroupForm,
  UserLabel,
  UserLabelCategory,
  UserLabelCategoryForm,
  UserLabelForm,
  UserLabelListQuery,
} from '@shop/contracts/user/schemas';
import type { PageQuery } from '@shop/contracts/conventions';
import type { DbOrTx, Tx } from '@shop/db';
import type { SQL } from 'drizzle-orm';
import { UserSessionService } from '../auth/user-session.service';
import { hashPassword } from '../auth/password';
import * as coupon from '../coupon';
import { requireAdminId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import { storefrontAuthConfig } from './storefront-auth.config';
import {
  anonymisedAccount,
  checkPasswordShape,
  defaultNickname,
  maskPhone,
  pageBounds,
  pickOrder,
  planBatch,
} from './user.rules';
import { announceAccountCancelled } from './user-cancelled';
import * as repo from './user.repo';
import { iso, toCancellation } from './user.service';

/**
 * The operator's side of the customer domain.
 *
 * What an operator may *not* do is as deliberate as what they may. There is no
 * "change this customer's phone number" (rebinding is the customer's own act,
 * guarded by an SMS code — an operator who could repoint an account at their
 * own handset would own every account in the shop), no hard delete, and no
 * route that returns an unmasked phone number in a list.
 */

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------

/** The 客户列表's filters, without its paging and sorting. */
export type AdminUserFilter = Omit<
  AdminUserListQuery,
  'page' | 'pageSize' | 'sortBy' | 'sortOrder'
>;

function toAdminListFilters(query: AdminUserFilter): repo.AdminListFilters {
  return {
    keyword: query.keyword,
    groupId: query.groupId === undefined ? undefined : fromId(query.groupId),
    labelId: query.labelId === undefined ? undefined : fromId(query.labelId),
    status: query.status,
    registerSource: query.registerSource,
    createdFrom: query.createdFrom === undefined ? undefined : new Date(query.createdFrom),
    createdTo: query.createdTo === undefined ? undefined : new Date(query.createdTo),
    hasWechat: query.hasWechat,
  };
}

/**
 * The users the 客户列表 would list under `filter`, for another domain to act
 * on (coupon's 按筛选发放). Returns at most `cap + 1` ids, lowest first, so the
 * caller can tell "exactly `cap`" from "more than `cap`" without a count.
 */
export async function userIdsForFilter(
  db: DbOrTx,
  filter: AdminUserFilter,
  cap: number,
): Promise<number[]> {
  return repo.userIdsMatching(db, toAdminListFilters(filter), cap + 1);
}

export async function adminList(
  ctx: Ctx,
  query: AdminUserListQuery,
): Promise<Paged<AdminUserListItem>> {
  const filters = toAdminListFilters(query);
  const [rows, total] = await Promise.all([
    repo.listUsers(ctx.db, {
      ...filters,
      ...pageBounds(query),
      orderBy: pickOrder(repo.orderBy.users, query.sortBy, query.sortOrder, 'id') as SQL,
    }),
    repo.countUsers(ctx.db, filters),
  ]);

  const ids = rows.map((r) => r.id);
  const [groups, labels] = await Promise.all([
    repo.loadGroupsFor(ctx.db, ids),
    repo.loadLabelsFor(ctx.db, ids),
  ]);
  return {
    items: rows.map((row) => toListItem(row, groups.get(row.id) ?? [], labels.get(row.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 新增用户.
 *
 * The account is the phone number, exactly as an SMS registration would make
 * it, so when the customer later signs in by SMS or binds that phone in WeChat
 * they land in this account rather than a second one. A phone that is already
 * an account is refused — the unique index decides, not a prior `SELECT`. The
 * row counts as a new customer (`register_source = 'admin'`) and gets the same
 * welcome coupons, inside the same transaction.
 */
export async function adminCreate(ctx: Ctx, body: AdminUserCreateBody): Promise<AdminUserDetail> {
  requireAdminId(ctx);
  if (body.password !== undefined && checkPasswordShape(body.password) !== 'ok') {
    throw new DomainError('VALIDATION_FAILED', {
      details: [{ field: 'body.password', message: '密码至少 6 位，且需包含至少两类字符' }],
    });
  }
  const passwordHash = body.password === undefined ? null : await hashPassword(body.password);
  const groupIds = body.groupIds.map(fromId);
  const labelIds = body.labelIds.map(fromId);

  const id = await ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    await assertKnown(tx, groupIds, labelIds);
    const inserted = await repo.insertUser(tx, {
      account: body.phone,
      phone: body.phone,
      passwordHash,
      passwordAlgo: passwordHash === null ? null : 'bcrypt',
      nickname: body.nickname ?? defaultNickname(body.phone),
      avatarUrl: null,
      registerSource: 'admin',
      registerIp: null,
      now,
    });
    if (!inserted) throw new DomainError('USER_PHONE_TAKEN');

    // What `insertUser` does not take goes on in the same transaction.
    await repo.updateProfile(tx, {
      id: inserted.id,
      realName: body.realName,
      adminRemark: body.adminRemark,
      birthday: body.birthday ? new Date(body.birthday) : undefined,
      now,
    });
    await repo.addGroupMemberships(tx, { userIds: [inserted.id], groupIds, now });
    await repo.addLabelMemberships(tx, { userIds: [inserted.id], labelIds, now });
    await coupon.grantNewUser(tx, ctx, inserted.id);
    return inserted.id;
  });
  ctx.logger.info({ userId: id, by: ctx.actor.id }, '管理员新增了用户');
  return loadDetail(ctx, id);
}

export async function adminDetail(ctx: Ctx, params: { id: string }): Promise<AdminUserDetail> {
  return loadDetail(ctx, fromId(params.id));
}

export async function adminUpdate(
  ctx: Ctx,
  params: { id: string },
  body: AdminUserForm,
): Promise<AdminUserDetail> {
  const id = fromId(params.id);
  const groupIds = body.groupIds.map(fromId);
  const labelIds = body.labelIds.map(fromId);

  await ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    await assertKnown(tx, groupIds, labelIds);
    const result = await repo.updateProfile(tx, {
      id,
      ...(body.nickname === undefined ? {} : { nickname: body.nickname }),
      ...(body.realName === undefined ? {} : { realName: body.realName }),
      ...(body.adminRemark === undefined ? {} : { adminRemark: body.adminRemark }),
      ...(body.birthday === undefined
        ? {}
        : { birthday: body.birthday === null ? null : new Date(body.birthday) }),
      now,
    });
    if (!result.won) throw new DomainError('USER_NOT_FOUND');

    // The form carries the complete membership, so the edit screen is a
    // `replace` — an `add` would make it impossible to take a label off.
    await repo.removeGroupMemberships(tx, { userIds: [id] });
    await repo.addGroupMemberships(tx, { userIds: [id], groupIds, now });
    await repo.removeLabelMemberships(tx, { userIds: [id] });
    await repo.addLabelMemberships(tx, { userIds: [id], labelIds, now });
  });
  return loadDetail(ctx, id);
}

/**
 * Enable or disable.
 *
 * The version bump inside `setStatus` revokes every live token, so a banned
 * account stops being able to order *now* rather than whenever its session
 * happened to expire — the invariant is "a disabled user's live token is
 * rejected".
 */
export async function adminSetStatus(
  ctx: Ctx,
  params: { id: string },
  body: AdminUserStatusBody,
): Promise<AdminUserDetail> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const current = await repo.findById(tx, id);
    if (!current || current.deletedAt !== null) throw new DomainError('USER_NOT_FOUND');
    const result = await repo.setStatus(tx, { id, status: body.status, now: ctx.clock.now() });
    // `affected === 0` here means it already had that status: idempotent, not
    // an error, and the caller gets the row back either way.
    if (result.won) {
      ctx.logger.info({ userId: id, status: body.status, by: ctx.actor.id }, '用户状态已变更');
    }
  });
  if (body.status === 'disabled') await revokeSessions(ctx, id);
  return loadDetail(ctx, id);
}

/**
 * Operator-set password.
 *
 * Support does this when an account is suspected stolen, so killing every live
 * session is the feature, not a side effect. The new password is never logged,
 * never mailed and never returned — the operator reads it out.
 */
export async function adminResetPassword(
  ctx: Ctx,
  params: { id: string },
  body: AdminUserPasswordBody,
): Promise<{ ok: true; revokedSessions: number }> {
  requireAdminId(ctx);
  const id = fromId(params.id);
  if (checkPasswordShape(body.password) !== 'ok') {
    throw new DomainError('VALIDATION_FAILED', {
      details: [{ field: 'body.password', message: '密码至少 6 位，且需包含至少两类字符' }],
    });
  }
  const hash = await hashPassword(body.password);
  await ctx.withTx(async (tx) => {
    const result = await repo.setPassword(tx, { id, hash, now: ctx.clock.now() });
    if (!result.won) throw new DomainError('USER_NOT_FOUND');
  });
  const revokedSessions = await revokeSessions(ctx, id);
  ctx.logger.info({ userId: id, by: ctx.actor.id, revokedSessions }, '管理员重置了用户密码');
  return { ok: true, revokedSessions };
}

/** Support reads these out over the phone; the list is short and never paged. */
export async function adminAddressList(
  ctx: Ctx,
  params: { id: string },
): Promise<{ items: UserAddress[] }> {
  const userId = fromId(params.id);
  const rows = await repo.listAddresses(ctx.db, { userId, limit: 100, offset: 0 });
  return { items: rows.map(toAdminAddress) };
}

export async function adminBatchSetGroups(
  ctx: Ctx,
  body: AdminUserBatchGroupBody,
): Promise<BatchResult> {
  const userIds = body.userIds.map(fromId);
  const groupIds = body.groupIds.map(fromId);
  const plan = planBatch(body.mode, groupIds);
  return ctx.withTx(async (tx) => {
    const known = await knownUsers(tx, userIds);
    await assertKnown(tx, groupIds, []);
    const now = ctx.clock.now();
    if (plan.clearAll) await repo.removeGroupMemberships(tx, { userIds: known });
    if (plan.removeIds.length > 0) {
      await repo.removeGroupMemberships(tx, { userIds: known, groupIds: plan.removeIds });
    }
    if (plan.addIds.length > 0) {
      await repo.addGroupMemberships(tx, { userIds: known, groupIds: plan.addIds, now });
    }
    return { affected: known.length };
  });
}

export async function adminBatchSetLabels(
  ctx: Ctx,
  body: AdminUserBatchLabelBody,
): Promise<BatchResult> {
  const userIds = body.userIds.map(fromId);
  const labelIds = body.labelIds.map(fromId);
  const plan = planBatch(body.mode, labelIds);
  return ctx.withTx(async (tx) => {
    const known = await knownUsers(tx, userIds);
    await assertKnown(tx, [], labelIds);
    const now = ctx.clock.now();
    if (plan.clearAll) await repo.removeLabelMemberships(tx, { userIds: known });
    if (plan.removeIds.length > 0) {
      await repo.removeLabelMemberships(tx, { userIds: known, labelIds: plan.removeIds });
    }
    if (plan.addIds.length > 0) {
      await repo.addLabelMemberships(tx, { userIds: known, labelIds: plan.addIds, now });
    }
    return { affected: known.length };
  });
}

/**
 * A batch that names an id nobody owns is a mistake in the caller, not a
 * partial success: silently skipping it is how an operator ends up believing
 * 500 customers were tagged when 3 were.
 */
async function assertKnown(tx: Tx, groupIds: number[], labelIds: number[]): Promise<void> {
  if (groupIds.length > 0) {
    const found = await repo.existingGroupIds(tx, groupIds);
    if (found.length !== new Set(groupIds).size) {
      throw new DomainError('USER_GROUP_NOT_FOUND', {
        details: { missing: groupIds.filter((id) => !found.includes(id)).map(String) },
      });
    }
  }
  if (labelIds.length > 0) {
    const found = await repo.existingLabelIds(tx, labelIds);
    if (found.length !== new Set(labelIds).size) {
      throw new DomainError('USER_LABEL_NOT_FOUND', {
        details: { missing: labelIds.filter((id) => !found.includes(id)).map(String) },
      });
    }
  }
}

async function knownUsers(tx: Tx, userIds: number[]): Promise<number[]> {
  const found = await repo.existingUserIds(tx, userIds);
  if (found.length !== new Set(userIds).size) {
    throw new DomainError('USER_BATCH_TARGET_UNKNOWN', {
      details: { missing: userIds.filter((id) => !found.includes(id)).map(String) },
    });
  }
  return found;
}

async function revokeSessions(ctx: Ctx, userId: number): Promise<number> {
  const config = await ctx.config.get(storefrontAuthConfig);
  return new UserSessionService(config.sessionTtlDays * 24 * 60 * 60 * 1000).revokeAllForUser(
    ctx,
    userId,
  );
}

async function loadDetail(ctx: Ctx, id: number): Promise<AdminUserDetail> {
  const row = await repo.findById(ctx.db, id);
  if (!row) throw new DomainError('USER_NOT_FOUND');
  const [groups, labels, platforms, addressCount] = await Promise.all([
    repo.loadGroupsFor(ctx.db, [id]),
    repo.loadLabelsFor(ctx.db, [id]),
    repo.listPlatformsForUser(ctx.db, id),
    repo.countAddresses(ctx.db, id),
  ]);
  return {
    ...toListItem(row, groups.get(id) ?? [], labels.get(id) ?? []),
    // Unmasked, and only here: this route carries `user:customer:read` on a
    // single record, not on a page of ten thousand.
    phone: row.phone,
    realName: row.realName,
    birthday: iso(row.birthday),
    adminRemark: row.adminRemark,
    registerIp: row.registerIp,
    lastLoginIp: row.lastLoginIp,
    hasPassword: row.passwordHash !== null,
    boundWechat: platforms,
    addressCount,
    deletedAt: iso(row.deletedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Ref = { id: number; name: string };

function toListItem(row: repo.UserRow, groups: Ref[], labels: Ref[]): AdminUserListItem {
  return {
    id: toId(row.id),
    account: row.account,
    phone: maskPhone(row.phone),
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    status: row.status,
    registerSource: row.registerSource,
    groups: groups.map(toRef),
    labels: labels.map(toRef),
    lastLoginAt: iso(row.lastLoginAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toRef(ref: Ref): NamedRef {
  return { id: toId(ref.id), name: ref.name };
}

function toAdminAddress(row: repo.AddressRow): UserAddress {
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
// cancellation review
// ---------------------------------------------------------------------------

export async function adminCancellationList(
  ctx: Ctx,
  query: CancellationListQuery,
): Promise<Paged<CancellationRequest>> {
  const filters = { status: query.status, keyword: query.keyword };
  const [rows, total] = await Promise.all([
    repo.listCancellations(ctx.db, {
      ...filters,
      ...pageBounds(query),
      orderBy: pickOrder(repo.orderBy.cancellations, query.sortBy, query.sortOrder, 'id') as SQL,
    }),
    repo.countCancellations(ctx.db, filters),
  ]);
  return { items: rows.map(toCancellation), total, page: query.page, pageSize: query.pageSize };
}

/**
 * Approve a 注销申请 — the one destructive operation in this domain, and it is
 * still not a delete.
 *
 * `users` is referenced by orders, refunds, invoices and coupons. A cascade
 * would erase a paying customer's purchase history along with the evidence for
 * any dispute; a restrict would fail at whatever hour the operator clicked 同意.
 * So the row survives with every identifying column emptied, `deleted_at` set,
 * a synthetic account name (so the unique index frees the old one for a future
 * registration), and `password_version` bumped so every device is signed out.
 * Reviews and group-buy teams stay — they are other shoppers' evidence too —
 * but no longer say whose they were (`onAccountCancelled`).
 *
 * The status guard is in the `UPDATE`, so two operators clicking 同意 at the
 * same instant produce one approval and one refusal — and the anonymisation
 * runs exactly once.
 */
export async function adminApproveCancellation(
  ctx: Ctx,
  params: { id: string },
  body: CancellationReviewBody,
): Promise<CancellationRequest> {
  const adminId = requireAdminId(ctx);
  const id = fromId(params.id);
  const userId = await ctx.withTx(async (tx) => {
    const request = await repo.findCancellation(tx, id);
    if (!request) throw new DomainError('USER_CANCELLATION_NOT_FOUND');
    const decided = await repo.decideCancellation(tx, {
      id,
      status: 'approved',
      adminId,
      remark: body.remark ?? null,
      now: ctx.clock.now(),
    });
    if (!decided.won) throw new DomainError('USER_CANCELLATION_NOT_PENDING');
    await repo.anonymise(tx, {
      id: request.userId,
      account: anonymisedAccount(),
      now: ctx.clock.now(),
    });
    // A company name, 税号 and bank account are not the customer's to keep
    // after 注销; issued invoices keep their own frozen copy.
    await repo.softDeleteInvoiceTitlesOf(tx, { userId: request.userId, now: ctx.clock.now() });
    // The openid must be free to register afresh, and the addresses are the
    // customer's personal data.
    await repo.releaseIdentitiesAndAddresses(tx, request.userId);
    // Reviews and group-buy teams keep their own copy of the nickname and
    // avatar; their domains blank it here, in the same transaction.
    await announceAccountCancelled(tx, ctx, { userId: request.userId });
    return request.userId;
  });
  const revoked = await revokeSessions(ctx, userId);
  ctx.logger.info({ userId, by: adminId, revoked }, '注销申请已通过，账号已匿名化');
  return afterReview(ctx, id);
}

export async function adminRejectCancellation(
  ctx: Ctx,
  params: { id: string },
  body: CancellationReviewBody,
): Promise<CancellationRequest> {
  const adminId = requireAdminId(ctx);
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const request = await repo.findCancellation(tx, id);
    if (!request) throw new DomainError('USER_CANCELLATION_NOT_FOUND');
    const decided = await repo.decideCancellation(tx, {
      id,
      status: 'rejected',
      adminId,
      remark: body.remark ?? null,
      now: ctx.clock.now(),
    });
    if (!decided.won) throw new DomainError('USER_CANCELLATION_NOT_PENDING');
  });
  return afterReview(ctx, id);
}

/** A note on a decided request. Does not move it back to `pending`. */
export async function adminRemarkCancellation(
  ctx: Ctx,
  params: { id: string },
  body: CancellationRemarkBody,
): Promise<CancellationRequest> {
  requireAdminId(ctx);
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const result = await repo.remarkCancellation(tx, {
      id,
      remark: body.remark,
      now: ctx.clock.now(),
    });
    if (!result.won) throw new DomainError('USER_CANCELLATION_NOT_FOUND');
  });
  return afterReview(ctx, id);
}

async function afterReview(ctx: Ctx, id: number): Promise<CancellationRequest> {
  const row = await repo.findCancellation(ctx.db, id);
  if (!row) throw new DomainError('USER_CANCELLATION_NOT_FOUND');
  return toCancellation(row);
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export async function groupList(
  ctx: Ctx,
  query: PageQuery & { sortBy?: string | undefined; sortOrder?: 'asc' | 'desc' | undefined },
): Promise<Paged<UserGroup>> {
  const [rows, total] = await Promise.all([
    repo.listGroups(ctx.db, {
      ...pageBounds(query),
      orderBy: pickOrder(repo.orderBy.groups, query.sortBy, query.sortOrder, 'sortOrder') as SQL,
    }),
    repo.countGroups(ctx.db),
  ]);
  return { items: rows.map(toGroup), total, page: query.page, pageSize: query.pageSize };
}

export async function groupCreate(ctx: Ctx, body: UserGroupForm): Promise<UserGroup> {
  const id = await ctx.withTx(async (tx) => {
    const row = await repo.insertGroup(tx, {
      name: body.name,
      sortOrder: body.sortOrder,
      now: ctx.clock.now(),
    });
    // `null` = `user_groups_name_uq` refused. The index decides, not a prior
    // `SELECT` that two concurrent creates would both pass.
    if (!row) throw new DomainError('USER_GROUP_NAME_TAKEN');
    return row.id;
  });
  return loadGroup(ctx, id);
}

export async function groupUpdate(
  ctx: Ctx,
  params: { id: string },
  body: UserGroupForm,
): Promise<UserGroup> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const result = await repo
      .updateGroup(tx, {
        id,
        name: body.name,
        sortOrder: body.sortOrder,
        now: ctx.clock.now(),
      })
      .catch(rethrowNameTaken('USER_GROUP_NAME_TAKEN'));
    if (!result.won) throw new DomainError('USER_GROUP_NOT_FOUND');
  });
  return loadGroup(ctx, id);
}

/**
 * Delete a group.
 *
 * The memberships go with it (`user_groups_map` cascades) and the customers do
 * not. There is no "group in use" refusal: a group exists to be regrouped, and
 * making an operator empty one by hand before deleting it is busywork.
 */
export async function groupDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const result = await repo.deleteGroup(tx, id);
    if (!result.won) throw new DomainError('USER_GROUP_NOT_FOUND');
  });
}

async function loadGroup(ctx: Ctx, id: number): Promise<UserGroup> {
  const row = await repo.findGroup(ctx.db, id);
  if (!row) throw new DomainError('USER_GROUP_NOT_FOUND');
  return toGroup(row);
}

function toGroup(row: repo.GroupRow): UserGroup {
  return {
    id: toId(row.id),
    name: row.name,
    sortOrder: row.sortOrder,
    memberCount: row.memberCount,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// label categories
// ---------------------------------------------------------------------------

export async function labelCategoryList(
  ctx: Ctx,
  query: PageQuery & { sortBy?: string | undefined; sortOrder?: 'asc' | 'desc' | undefined },
): Promise<Paged<UserLabelCategory>> {
  const [rows, total] = await Promise.all([
    repo.listLabelCategories(ctx.db, {
      ...pageBounds(query),
      orderBy: pickOrder(
        repo.orderBy.labelCategories,
        query.sortBy,
        query.sortOrder,
        'sortOrder',
      ) as SQL,
    }),
    repo.countLabelCategories(ctx.db),
  ]);
  return { items: rows.map(toLabelCategory), total, page: query.page, pageSize: query.pageSize };
}

export async function labelCategoryCreate(
  ctx: Ctx,
  body: UserLabelCategoryForm,
): Promise<UserLabelCategory> {
  const id = await ctx.withTx(async (tx) => {
    const row = await repo.insertLabelCategory(tx, {
      name: body.name,
      sortOrder: body.sortOrder,
      now: ctx.clock.now(),
    });
    if (!row) throw new DomainError('USER_LABEL_CATEGORY_NAME_TAKEN');
    return row.id;
  });
  return loadLabelCategory(ctx, id);
}

export async function labelCategoryUpdate(
  ctx: Ctx,
  params: { id: string },
  body: UserLabelCategoryForm,
): Promise<UserLabelCategory> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const result = await repo
      .updateLabelCategory(tx, {
        id,
        name: body.name,
        sortOrder: body.sortOrder,
        now: ctx.clock.now(),
      })
      .catch(rethrowNameTaken('USER_LABEL_CATEGORY_NAME_TAKEN'));
    if (!result.won) throw new DomainError('USER_LABEL_CATEGORY_NOT_FOUND');
  });
  return loadLabelCategory(ctx, id);
}

/** The labels survive; `user_labels.category_id` is `ON DELETE SET NULL`. */
export async function labelCategoryDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const result = await repo.deleteLabelCategory(tx, id);
    if (!result.won) throw new DomainError('USER_LABEL_CATEGORY_NOT_FOUND');
  });
}

async function loadLabelCategory(ctx: Ctx, id: number): Promise<UserLabelCategory> {
  const row = await repo.findLabelCategory(ctx.db, id);
  if (!row) throw new DomainError('USER_LABEL_CATEGORY_NOT_FOUND');
  return toLabelCategory(row);
}

function toLabelCategory(row: repo.LabelCategoryRow): UserLabelCategory {
  return {
    id: toId(row.id),
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export async function labelList(ctx: Ctx, query: UserLabelListQuery): Promise<Paged<UserLabel>> {
  const filters = {
    categoryId: query.categoryId === undefined ? undefined : fromId(query.categoryId),
    keyword: query.keyword,
  };
  const [rows, total] = await Promise.all([
    repo.listLabels(ctx.db, {
      ...filters,
      ...pageBounds(query),
      orderBy: pickOrder(repo.orderBy.labels, query.sortBy, query.sortOrder, 'sortOrder') as SQL,
    }),
    repo.countLabels(ctx.db, filters),
  ]);
  return { items: rows.map(toLabel), total, page: query.page, pageSize: query.pageSize };
}

export async function labelCreate(ctx: Ctx, body: UserLabelForm): Promise<UserLabel> {
  const categoryId =
    body.categoryId === undefined || body.categoryId === null ? null : fromId(body.categoryId);
  const id = await ctx.withTx(async (tx) => {
    if (categoryId !== null) {
      const found = await repo.findLabelCategory(tx, categoryId);
      if (!found) throw new DomainError('USER_LABEL_CATEGORY_NOT_FOUND');
    }
    const row = await repo.insertLabel(tx, {
      categoryId,
      name: body.name,
      sortOrder: body.sortOrder,
      now: ctx.clock.now(),
    });
    if (!row) throw new DomainError('USER_LABEL_NAME_TAKEN');
    return row.id;
  });
  return loadLabel(ctx, id);
}

export async function labelUpdate(
  ctx: Ctx,
  params: { id: string },
  body: UserLabelForm,
): Promise<UserLabel> {
  const id = fromId(params.id);
  const categoryId =
    body.categoryId === undefined || body.categoryId === null ? null : fromId(body.categoryId);
  await ctx.withTx(async (tx) => {
    if (categoryId !== null) {
      const found = await repo.findLabelCategory(tx, categoryId);
      if (!found) throw new DomainError('USER_LABEL_CATEGORY_NOT_FOUND');
    }
    const result = await repo
      .updateLabel(tx, {
        id,
        categoryId,
        name: body.name,
        sortOrder: body.sortOrder,
        now: ctx.clock.now(),
      })
      .catch(rethrowNameTaken('USER_LABEL_NAME_TAKEN'));
    if (!result.won) throw new DomainError('USER_LABEL_NOT_FOUND');
  });
  return loadLabel(ctx, id);
}

export async function labelDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const result = await repo.deleteLabel(tx, id);
    if (!result.won) throw new DomainError('USER_LABEL_NOT_FOUND');
  });
}

async function loadLabel(ctx: Ctx, id: number): Promise<UserLabel> {
  const row = await repo.findLabel(ctx.db, id);
  if (!row) throw new DomainError('USER_LABEL_NOT_FOUND');
  return toLabel(row);
}

function toLabel(row: repo.LabelRow): UserLabel {
  return {
    id: toId(row.id),
    categoryId: toIdOrNull(row.categoryId),
    categoryName: row.categoryName,
    name: row.name,
    sortOrder: row.sortOrder,
    memberCount: row.memberCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A rename that collides raises a unique violation from PostgreSQL rather than
 * returning zero rows, because there is no `ON CONFLICT` on an `UPDATE`. Turn
 * it into the same 409 a create would give; anything else is re-thrown.
 *
 * The code is looked for down the `cause` chain, not on the error itself:
 * drizzle wraps the driver error in a `DrizzleQueryError` and the `23505` is
 * one level down. Reading only the top level makes this function a no-op that
 * looks like it works.
 */
function rethrowNameTaken(code: string): (error: unknown) => never {
  return (error: unknown) => {
    if (isUniqueViolation(error)) throw new DomainError(code, { cause: error });
    throw error;
  };
}

function isUniqueViolation(error: unknown): boolean {
  for (
    let current = error, depth = 0;
    current !== null && current !== undefined && depth < 5;
    depth += 1
  ) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
