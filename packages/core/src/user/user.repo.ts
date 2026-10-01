import type { DbOrTx, Tx } from '@shop/db';
import {
  userAddresses,
  userCancellationRequests,
  userGroups,
  userGroupsMap,
  userInvoiceProfiles,
  userLabelCategories,
  userLabels,
  userLabelsMap,
  users,
} from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { containsPattern } from '../kernel/like';
import { conditionalDelete, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * The only file allowed to touch `users`, `user_addresses`, `user_groups*`,
 * `user_labels*`, `user_invoice_profiles`, `user_cancellation_requests` and
 * `wechat_identities`.
 *
 * Statements, not decisions. Every precondition that matters lives in a
 * `WHERE`: a read followed by a write is a race, and the four places this
 * domain changes state under contention — the default address, the
 * cancellation review, the phone binding and the password version — are all
 * conditional updates whose affected-row count is the answer.
 */

export interface UserRow {
  id: number;
  account: string;
  phone: string | null;
  passwordHash: string | null;
  passwordAlgo: 'bcrypt' | 'md5_legacy' | null;
  passwordVersion: number;
  nickname: string | null;
  avatarUrl: string | null;
  realName: string | null;
  birthday: Date | null;
  adminRemark: string | null;
  status: 'active' | 'disabled';
  registerSource: 'h5' | 'wechat_oa' | 'wechat_mini' | 'admin' | null;
  registerIp: string | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const userColumns = {
  id: users.id,
  account: users.account,
  phone: users.phone,
  passwordHash: users.passwordHash,
  passwordAlgo: users.passwordAlgo,
  passwordVersion: users.passwordVersion,
  nickname: users.nickname,
  avatarUrl: users.avatarUrl,
  realName: users.realName,
  birthday: users.birthday,
  adminRemark: users.adminRemark,
  status: users.status,
  registerSource: users.registerSource,
  registerIp: users.registerIp,
  lastLoginAt: users.lastLoginAt,
  lastLoginIp: users.lastLoginIp,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  deletedAt: users.deletedAt,
} as const;

// ---------------------------------------------------------------------------
// users: reads
// ---------------------------------------------------------------------------

export async function findById(db: DbOrTx, id: number): Promise<UserRow | null> {
  const rows = await db.select(userColumns).from(users).where(eq(users.id, id)).limit(1);
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * Sign-in lookup. Case-insensitive, and it matches the account column *or* the
 * phone column, because a customer who registered by phone thinks of the number
 * as their account.
 *
 * `lower(...)` on both sides so the expression indexes
 * (`users_account_lower_uq`, `users_phone_lower_uq`) are used rather than a
 * sequential scan of every customer on every login attempt.
 */
export async function findByAccountOrPhone(db: DbOrTx, account: string): Promise<UserRow | null> {
  const folded = account.trim().toLowerCase();
  if (!folded) return null;
  const rows = await db
    .select(userColumns)
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        or(sql`lower(${users.account}) = ${folded}`, sql`lower(${users.phone}) = ${folded}`),
      ),
    )
    .limit(1);
  return (rows[0] as UserRow | undefined) ?? null;
}

export async function findByPhone(db: DbOrTx, phone: string): Promise<UserRow | null> {
  const folded = phone.trim().toLowerCase();
  if (!folded) return null;
  const rows = await db
    .select(userColumns)
    .from(users)
    .where(and(isNull(users.deletedAt), sql`lower(${users.phone}) = ${folded}`))
    .limit(1);
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * The number a notification SMS goes to: `null` when the member has none, or
 * the account is closed (`anonymise` clears it anyway; the `deletedAt` check
 * says so out loud).
 */
export async function findPhone(db: DbOrTx, id: number): Promise<string | null> {
  const rows = await db
    .select({ phone: users.phone })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  const phone = rows[0]?.phone?.trim() ?? '';
  return phone === '' ? null : phone;
}

/** What `UserLookup` needs, and nothing else — it runs on every authenticated request. */
export async function findAuthState(
  db: DbOrTx,
  id: number,
): Promise<{ id: number; passwordVersion: number; status: number } | null> {
  const rows = await db
    .select({
      id: users.id,
      passwordVersion: users.passwordVersion,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // A cancelled account reads as disabled rather than as "not found": its
  // sessions must die, and the distinction is invisible to the caller anyway.
  const active = row.status === 'active' && row.deletedAt === null;
  return { id: row.id, passwordVersion: row.passwordVersion, status: active ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// users: writes
// ---------------------------------------------------------------------------

export interface InsertUserInput {
  account: string;
  phone: string | null;
  passwordHash: string | null;
  passwordAlgo: 'bcrypt' | 'md5_legacy' | null;
  nickname: string | null;
  avatarUrl: string | null;
  registerSource: 'h5' | 'wechat_oa' | 'wechat_mini' | 'admin' | null;
  registerIp: string | null;
  now: Date;
}

/**
 * Create a customer.
 *
 * Returns `null` when a unique index refused the insert, which is how two
 * concurrent registrations of one phone number resolve: the loser learns it
 * lost from PostgreSQL rather than from a prior `SELECT` that proved nothing.
 * `ON CONFLICT DO NOTHING` covers both `users_account_lower_uq` and
 * `users_phone_lower_uq`.
 */
export async function insertUser(tx: Tx, input: InsertUserInput): Promise<UserRow | null> {
  const rows = await tx
    .insert(users)
    .values({
      account: input.account,
      phone: input.phone,
      passwordHash: input.passwordHash,
      passwordAlgo: input.passwordAlgo,
      nickname: input.nickname,
      avatarUrl: input.avatarUrl,
      registerSource: input.registerSource,
      registerIp: input.registerIp,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning(userColumns);
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * Set the password and bump `password_version` in one statement.
 *
 * The bump is what revokes every live session: `UserSessionService.resolve`
 * compares the version the token was minted with against this column. Doing it
 * in the same UPDATE as the hash means there is no instant at which the new
 * password is live and the old sessions are too.
 */
export async function setPassword(
  tx: Tx,
  args: { id: number; hash: string; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, users, {
    where: and(eq(users.id, args.id), isNull(users.deletedAt)),
    set: {
      passwordHash: args.hash,
      passwordAlgo: 'bcrypt',
      passwordVersion: sql`${users.passwordVersion} + 1`,
      updatedAt: args.now,
    },
  });
}

/**
 * Rewrite a legacy MD5 hash as bcrypt after a successful sign-in.
 *
 * Conditional on the hash we just verified, so two concurrent logins upgrade
 * once; and it does **not** bump `password_version`, because the password did
 * not change — bumping would log the customer out of their other devices as a
 * side effect of logging in here.
 */
export async function upgradePasswordHash(
  db: DbOrTx,
  args: { id: number; fromHash: string; toHash: string; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, users, {
    where: and(
      eq(users.id, args.id),
      eq(users.passwordHash, args.fromHash),
      eq(users.passwordAlgo, 'md5_legacy'),
    ),
    set: { passwordHash: args.toHash, passwordAlgo: 'bcrypt', updatedAt: args.now },
  });
}

export async function setStatus(
  tx: Tx,
  args: { id: number; status: 'active' | 'disabled'; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, users, {
    where: and(eq(users.id, args.id), ne(users.status, args.status), isNull(users.deletedAt)),
    set: {
      status: args.status,
      // Disabling must kill live tokens immediately; re-enabling bumps too, so
      // the two directions cannot be told apart by watching session lifetimes.
      passwordVersion: sql`${users.passwordVersion} + 1`,
      updatedAt: args.now,
    },
  });
}

export async function touchLastLogin(
  db: DbOrTx,
  args: { id: number; ip: string | null; now: Date },
): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: args.now, lastLoginIp: args.ip })
    .where(eq(users.id, args.id));
}

/**
 * Puts the default avatar back, but only if the account still shows `url` —
 * a customer who already replaced it keeps the replacement (C09).
 */
export async function resetAvatarIf(
  tx: Tx,
  args: { id: number; url: string; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, users, {
    where: and(eq(users.id, args.id), eq(users.avatarUrl, args.url)),
    set: { avatarUrl: null, updatedAt: args.now },
  });
}

export async function updateProfile(
  tx: Tx,
  args: {
    id: number;
    nickname?: string | undefined;
    avatarUrl?: string | null | undefined;
    realName?: string | null | undefined;
    birthday?: Date | null | undefined;
    adminRemark?: string | null | undefined;
    now: Date;
  },
): Promise<ConditionalUpdateResult> {
  const set: Record<string, unknown> = { updatedAt: args.now };
  if (args.nickname !== undefined) set.nickname = args.nickname;
  if (args.avatarUrl !== undefined) set.avatarUrl = args.avatarUrl;
  if (args.realName !== undefined) set.realName = args.realName;
  if (args.birthday !== undefined) set.birthday = args.birthday;
  if (args.adminRemark !== undefined) set.adminRemark = args.adminRemark;
  return conditionalUpdate(tx, users, {
    where: and(eq(users.id, args.id), isNull(users.deletedAt)),
    set,
  });
}

/**
 * Bind a phone number, and take the account name with it when the account name
 * is still the synthetic one.
 *
 * Conditional on the account **not already having a number** (`bind`) or on
 * having the one we were told about (`rebind`), so two taps of 绑定 bind once.
 */
export async function bindPhone(
  tx: Tx,
  args: {
    id: number;
    phone: string;
    alsoSetAccount: boolean;
    expectPhone: string | null;
    now: Date;
  },
): Promise<ConditionalUpdateResult> {
  const set: Record<string, unknown> = { phone: args.phone, updatedAt: args.now };
  if (args.alsoSetAccount) set.account = args.phone;
  return conditionalUpdate(tx, users, {
    where: and(
      eq(users.id, args.id),
      isNull(users.deletedAt),
      args.expectPhone === null ? isNull(users.phone) : eq(users.phone, args.expectPhone),
    ),
    set,
  });
}

/**
 * Anonymise an approved cancellation.
 *
 * Never a `DELETE`. Orders, refunds, invoices and coupons all reference the id;
 * a cascade would erase a paying customer's purchase history and a restrict
 * would fail at whatever hour the operator clicked 同意. `deleted_at` marks the
 * row dead, the version bump kills the sessions, and the account name becomes a
 * synthetic handle so `users_account_lower_uq` cannot collide with a future
 * registration from the same number.
 */
export async function anonymise(
  tx: Tx,
  args: { id: number; account: string; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, users, {
    where: and(eq(users.id, args.id), isNull(users.deletedAt)),
    set: {
      account: args.account,
      phone: null,
      passwordHash: null,
      passwordAlgo: null,
      passwordVersion: sql`${users.passwordVersion} + 1`,
      nickname: null,
      avatarUrl: null,
      realName: null,
      birthday: null,
      adminRemark: null,
      status: 'disabled',
      lastLoginIp: null,
      registerIp: null,
      deletedAt: args.now,
      updatedAt: args.now,
    },
  });
}

// ---------------------------------------------------------------------------
// wechat identities
// ---------------------------------------------------------------------------

export interface WechatIdentityRow {
  id: number;
  userId: number;
  platform: 'oa' | 'mini';
  openid: string;
  unionid: string | null;
}

export async function findIdentityByOpenid(
  db: DbOrTx,
  args: { platform: 'oa' | 'mini'; openid: string },
): Promise<WechatIdentityRow | null> {
  const rows = await db
    .select({
      id: wechatIdentities.id,
      userId: wechatIdentities.userId,
      platform: wechatIdentities.platform,
      openid: wechatIdentities.openid,
      unionid: wechatIdentities.unionid,
    })
    .from(wechatIdentities)
    .where(
      and(eq(wechatIdentities.platform, args.platform), eq(wechatIdentities.openid, args.openid)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The same person on the other WeChat app.
 *
 * Only meaningful once both apps sit under one Open Platform account, which is
 * why `unionid` is nullable and why this returns `null` rather than guessing.
 */
export async function findIdentityByUnionid(
  db: DbOrTx,
  unionid: string,
): Promise<WechatIdentityRow | null> {
  const rows = await db
    .select({
      id: wechatIdentities.id,
      userId: wechatIdentities.userId,
      platform: wechatIdentities.platform,
      openid: wechatIdentities.openid,
      unionid: wechatIdentities.unionid,
    })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.unionid, unionid))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Attach an openid to a customer.
 *
 * `ON CONFLICT DO NOTHING` on both unique indexes: `wechat_identities_openid_uq`
 * (this openid is already somebody's) and `wechat_identities_user_platform_uq`
 * (this customer already has an identity on this app). `null` means one of the
 * two refused, and the caller turns that into `AUTH_WECHAT_ALREADY_BOUND`.
 */
export async function insertIdentity(
  tx: Tx,
  args: {
    userId: number;
    platform: 'oa' | 'mini';
    openid: string;
    unionid: string | null;
    nickname: string | null;
    avatarUrl: string | null;
    now: Date;
  },
): Promise<WechatIdentityRow | null> {
  const rows = await tx
    .insert(wechatIdentities)
    .values({
      userId: args.userId,
      platform: args.platform,
      openid: args.openid,
      unionid: args.unionid,
      nickname: args.nickname,
      avatarUrl: args.avatarUrl,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoNothing()
    .returning({
      id: wechatIdentities.id,
      userId: wechatIdentities.userId,
      platform: wechatIdentities.platform,
      openid: wechatIdentities.openid,
      unionid: wechatIdentities.unionid,
    });
  return rows[0] ?? null;
}

export async function listPlatformsForUser(
  db: DbOrTx,
  userId: number,
): Promise<Array<'oa' | 'mini'>> {
  const rows = await db
    .select({ platform: wechatIdentities.platform })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.userId, userId))
    .orderBy(asc(wechatIdentities.platform));
  return rows.map((r) => r.platform);
}

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

export interface AddressRow {
  id: number;
  userId: number;
  receiverName: string;
  receiverPhone: string;
  provinceId: number | null;
  cityId: number | null;
  districtId: number | null;
  provinceName: string;
  cityName: string;
  districtName: string | null;
  detail: string;
  postCode: string | null;
  lng: string | null;
  lat: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const addressColumns = {
  id: userAddresses.id,
  userId: userAddresses.userId,
  receiverName: userAddresses.receiverName,
  receiverPhone: userAddresses.receiverPhone,
  provinceId: userAddresses.provinceId,
  cityId: userAddresses.cityId,
  districtId: userAddresses.districtId,
  provinceName: userAddresses.provinceName,
  cityName: userAddresses.cityName,
  districtName: userAddresses.districtName,
  detail: userAddresses.detail,
  postCode: userAddresses.postCode,
  lng: userAddresses.lng,
  lat: userAddresses.lat,
  isDefault: userAddresses.isDefault,
  createdAt: userAddresses.createdAt,
  updatedAt: userAddresses.updatedAt,
} as const;

/** Every address read carries the owner in the WHERE. There is no read by id alone. */
export async function findAddress(
  db: DbOrTx,
  args: { id: number; userId: number },
): Promise<AddressRow | null> {
  const rows = await db
    .select(addressColumns)
    .from(userAddresses)
    .where(
      and(
        eq(userAddresses.id, args.id),
        eq(userAddresses.userId, args.userId),
        isNull(userAddresses.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listAddresses(
  db: DbOrTx,
  args: { userId: number; limit: number; offset: number },
): Promise<AddressRow[]> {
  return db
    .select(addressColumns)
    .from(userAddresses)
    .where(and(eq(userAddresses.userId, args.userId), isNull(userAddresses.deletedAt)))
    .orderBy(desc(userAddresses.isDefault), desc(userAddresses.id))
    .limit(args.limit)
    .offset(args.offset);
}

export async function countAddresses(db: DbOrTx, userId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userAddresses)
    .where(and(eq(userAddresses.userId, userId), isNull(userAddresses.deletedAt)));
  return rows[0]?.n ?? 0;
}

export async function findDefaultAddress(db: DbOrTx, userId: number): Promise<AddressRow | null> {
  const rows = await db
    .select(addressColumns)
    .from(userAddresses)
    .where(
      and(
        eq(userAddresses.userId, userId),
        eq(userAddresses.isDefault, true),
        isNull(userAddresses.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface AddressInput {
  receiverName: string;
  receiverPhone: string;
  provinceId: number | null;
  cityId: number | null;
  districtId: number | null;
  provinceName: string;
  cityName: string;
  districtName: string | null;
  detail: string;
  postCode: string | null;
  lng: string | null;
  lat: string | null;
  isDefault: boolean;
}

export async function insertAddress(
  tx: Tx,
  args: AddressInput & { userId: number; now: Date },
): Promise<AddressRow> {
  const rows = await tx
    .insert(userAddresses)
    .values({ ...args, createdAt: args.now, updatedAt: args.now })
    .returning(addressColumns);
  const row = rows[0];
  if (!row) throw new Error('user_addresses: insert returned no row');
  return row;
}

export async function updateAddress(
  tx: Tx,
  args: AddressInput & { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  const { id, userId, now, ...fields } = args;
  return conditionalUpdate(tx, userAddresses, {
    where: and(
      eq(userAddresses.id, id),
      eq(userAddresses.userId, userId),
      isNull(userAddresses.deletedAt),
    ),
    set: { ...fields, updatedAt: now },
  });
}

/**
 * Serialises one customer's address-book writes that pick a default (deleting the default
 * promotes the next), so two at once cannot both promote and trip `user_addresses_default_uq`.
 */
export async function lockAddressBook(tx: Tx, userId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`user-addresses:${userId}`}, 0))`,
  );
}

export async function softDeleteAddress(
  tx: Tx,
  args: { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userAddresses, {
    where: and(
      eq(userAddresses.id, args.id),
      eq(userAddresses.userId, args.userId),
      isNull(userAddresses.deletedAt),
    ),
    set: { isDefault: false, deletedAt: args.now, updatedAt: args.now },
  });
}

/**
 * Clear whoever currently holds the default flag for this customer.
 *
 * Called immediately before setting a new one, inside the same transaction:
 * `user_addresses_default_uq` is a partial unique index, so doing it the other
 * way round raises a constraint violation rather than replacing the default.
 */
export async function clearDefaultAddress(
  tx: Tx,
  args: { userId: number; exceptId?: number; now: Date },
): Promise<number> {
  const conditions: SQL[] = [
    eq(userAddresses.userId, args.userId),
    eq(userAddresses.isDefault, true),
    isNull(userAddresses.deletedAt),
  ];
  if (args.exceptId !== undefined) conditions.push(ne(userAddresses.id, args.exceptId));
  const result = await conditionalUpdate(tx, userAddresses, {
    where: and(...conditions),
    set: { isDefault: false, updatedAt: args.now },
  });
  return result.affected;
}

export async function setDefaultAddress(
  tx: Tx,
  args: { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userAddresses, {
    where: and(
      eq(userAddresses.id, args.id),
      eq(userAddresses.userId, args.userId),
      isNull(userAddresses.deletedAt),
    ),
    set: { isDefault: true, updatedAt: args.now },
  });
}

// ---------------------------------------------------------------------------
// invoice titles (user_invoice_profiles)
// ---------------------------------------------------------------------------

export interface InvoiceTitleRow {
  id: number;
  userId: number;
  headerType: 'personal' | 'company';
  invoiceType: 'plain' | 'special';
  name: string;
  dutyNumber: string | null;
  drawerPhone: string | null;
  email: string | null;
  registeredTel: string | null;
  registeredAddress: string | null;
  bankName: string | null;
  bankAccount: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceTitleColumns = {
  id: userInvoiceProfiles.id,
  userId: userInvoiceProfiles.userId,
  headerType: userInvoiceProfiles.headerType,
  invoiceType: userInvoiceProfiles.invoiceType,
  name: userInvoiceProfiles.name,
  dutyNumber: userInvoiceProfiles.dutyNumber,
  drawerPhone: userInvoiceProfiles.drawerPhone,
  email: userInvoiceProfiles.email,
  registeredTel: userInvoiceProfiles.registeredTel,
  registeredAddress: userInvoiceProfiles.registeredAddress,
  bankName: userInvoiceProfiles.bankName,
  bankAccount: userInvoiceProfiles.bankAccount,
  isDefault: userInvoiceProfiles.isDefault,
  createdAt: userInvoiceProfiles.createdAt,
  updatedAt: userInvoiceProfiles.updatedAt,
} as const;

const liveTitleOf = (args: { id: number; userId: number }): SQL =>
  and(
    eq(userInvoiceProfiles.id, args.id),
    eq(userInvoiceProfiles.userId, args.userId),
    isNull(userInvoiceProfiles.deletedAt),
  )!;

/**
 * Serialise every write to one customer's title book.
 *
 * A transaction-scoped advisory lock keyed on the user id, taken first by
 * every create / update / delete / set-default. Without it two creates both
 * count 19 and both insert past the cap, and two promotions each clear the
 * other's flag before setting their own — one of them then dies on
 * `user_invoice_profiles_default_uq` with a 500 instead of simply winning in
 * turn. An advisory lock rather than `SELECT … FOR UPDATE` on `users`, so the
 * book never blocks the orders and carts whose foreign keys share-lock that
 * row.
 */
export async function lockInvoiceTitleBook(tx: Tx, userId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`user-invoice-titles:${userId}`}, 0))`,
  );
}

/** Every title read carries the owner in the WHERE. There is no read by id alone. */
export async function findInvoiceTitle(
  db: DbOrTx,
  args: { id: number; userId: number },
): Promise<InvoiceTitleRow | null> {
  const rows = await db
    .select(invoiceTitleColumns)
    .from(userInvoiceProfiles)
    .where(liveTitleOf(args))
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvoiceTitles(
  db: DbOrTx,
  args: { userId: number; limit: number; offset: number },
): Promise<InvoiceTitleRow[]> {
  return db
    .select(invoiceTitleColumns)
    .from(userInvoiceProfiles)
    .where(and(eq(userInvoiceProfiles.userId, args.userId), isNull(userInvoiceProfiles.deletedAt)))
    .orderBy(desc(userInvoiceProfiles.isDefault), desc(userInvoiceProfiles.id))
    .limit(args.limit)
    .offset(args.offset);
}

export async function countInvoiceTitles(db: DbOrTx, userId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userInvoiceProfiles)
    .where(and(eq(userInvoiceProfiles.userId, userId), isNull(userInvoiceProfiles.deletedAt)));
  return rows[0]?.n ?? 0;
}

export async function findDefaultInvoiceTitle(
  db: DbOrTx,
  userId: number,
): Promise<InvoiceTitleRow | null> {
  const rows = await db
    .select(invoiceTitleColumns)
    .from(userInvoiceProfiles)
    .where(
      and(
        eq(userInvoiceProfiles.userId, userId),
        eq(userInvoiceProfiles.isDefault, true),
        isNull(userInvoiceProfiles.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface InvoiceTitleInput {
  headerType: 'personal' | 'company';
  invoiceType: 'plain' | 'special';
  name: string;
  dutyNumber: string | null;
  drawerPhone: string | null;
  email: string | null;
  registeredTel: string | null;
  registeredAddress: string | null;
  bankName: string | null;
  bankAccount: string | null;
  isDefault: boolean;
}

export async function insertInvoiceTitle(
  tx: Tx,
  args: InvoiceTitleInput & { userId: number; now: Date },
): Promise<InvoiceTitleRow> {
  const { now, ...values } = args;
  const rows = await tx
    .insert(userInvoiceProfiles)
    .values({ ...values, createdAt: now, updatedAt: now })
    .returning(invoiceTitleColumns);
  const row = rows[0];
  if (!row) throw new Error('user_invoice_profiles: insert returned no row');
  return row;
}

export async function updateInvoiceTitle(
  tx: Tx,
  args: InvoiceTitleInput & { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  const { id, userId, now, ...fields } = args;
  return conditionalUpdate(tx, userInvoiceProfiles, {
    where: liveTitleOf({ id, userId }),
    set: { ...fields, updatedAt: now },
  });
}

export async function softDeleteInvoiceTitle(
  tx: Tx,
  args: { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userInvoiceProfiles, {
    where: liveTitleOf(args),
    set: { isDefault: false, deletedAt: args.now, updatedAt: args.now },
  });
}

/**
 * Soft-delete every live title of a customer — the cancellation approval, so an
 * anonymised account keeps no company name, 税号 or bank account behind it.
 */
export async function softDeleteInvoiceTitlesOf(
  tx: Tx,
  args: { userId: number; now: Date },
): Promise<number> {
  const result = await conditionalUpdate(tx, userInvoiceProfiles, {
    where: and(eq(userInvoiceProfiles.userId, args.userId), isNull(userInvoiceProfiles.deletedAt)),
    set: { isDefault: false, deletedAt: args.now, updatedAt: args.now },
  });
  return result.affected;
}

/**
 * 注销: the WeChat identities and the address book go outright. Nothing
 * references either by id (orders keep their own receiver snapshot), and a
 * soft delete would keep exactly the personal data 注销 promises to remove —
 * while a kept identity would tie the openid to the anonymised row forever.
 */
export async function releaseIdentitiesAndAddresses(
  tx: Tx,
  userId: number,
): Promise<{ identities: number; addresses: number }> {
  const identities = await tx
    .delete(wechatIdentities)
    .where(eq(wechatIdentities.userId, userId))
    .returning({ id: wechatIdentities.id });
  const addresses = await tx
    .delete(userAddresses)
    .where(eq(userAddresses.userId, userId))
    .returning({ id: userAddresses.id });
  return { identities: identities.length, addresses: addresses.length };
}

/** Clear the current default. Called before setting a new one, in the same transaction. */
export async function clearDefaultInvoiceTitle(
  tx: Tx,
  args: { userId: number; exceptId?: number; now: Date },
): Promise<number> {
  const conditions: SQL[] = [
    eq(userInvoiceProfiles.userId, args.userId),
    eq(userInvoiceProfiles.isDefault, true),
    isNull(userInvoiceProfiles.deletedAt),
  ];
  if (args.exceptId !== undefined) conditions.push(ne(userInvoiceProfiles.id, args.exceptId));
  const result = await conditionalUpdate(tx, userInvoiceProfiles, {
    where: and(...conditions),
    set: { isDefault: false, updatedAt: args.now },
  });
  return result.affected;
}

export async function setDefaultInvoiceTitle(
  tx: Tx,
  args: { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userInvoiceProfiles, {
    where: liveTitleOf(args),
    set: { isDefault: true, updatedAt: args.now },
  });
}

// ---------------------------------------------------------------------------
// groups and labels
// ---------------------------------------------------------------------------

export interface GroupRow {
  id: number;
  name: string;
  sortOrder: number;
  createdAt: Date;
  memberCount: number;
}

export async function listGroups(
  db: DbOrTx,
  args: { limit: number; offset: number; orderBy: SQL },
): Promise<GroupRow[]> {
  return db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      sortOrder: userGroups.sortOrder,
      createdAt: userGroups.createdAt,
      memberCount: sql<number>`(select count(*)::int from ${userGroupsMap} where ${userGroupsMap.groupId} = ${userGroups.id})`,
    })
    .from(userGroups)
    .orderBy(args.orderBy)
    .limit(args.limit)
    .offset(args.offset);
}

export async function countGroups(db: DbOrTx): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(userGroups);
  return rows[0]?.n ?? 0;
}

export async function findGroup(db: DbOrTx, id: number): Promise<GroupRow | null> {
  const rows = await db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      sortOrder: userGroups.sortOrder,
      createdAt: userGroups.createdAt,
      memberCount: sql<number>`(select count(*)::int from ${userGroupsMap} where ${userGroupsMap.groupId} = ${userGroups.id})`,
    })
    .from(userGroups)
    .where(eq(userGroups.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** `null` when `user_groups_name_uq` refused; the caller maps that to a 409. */
export async function insertGroup(
  tx: Tx,
  args: { name: string; sortOrder: number; now: Date },
): Promise<{ id: number } | null> {
  const rows = await tx
    .insert(userGroups)
    .values({
      name: args.name,
      sortOrder: args.sortOrder,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoNothing()
    .returning({ id: userGroups.id });
  return rows[0] ?? null;
}

export async function updateGroup(
  tx: Tx,
  args: { id: number; name: string; sortOrder: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userGroups, {
    where: eq(userGroups.id, args.id),
    set: { name: args.name, sortOrder: args.sortOrder, updatedAt: args.now },
  });
}

export async function deleteGroup(tx: Tx, id: number): Promise<ConditionalUpdateResult> {
  return conditionalDelete(tx, userGroups, eq(userGroups.id, id));
}

export interface LabelCategoryRow {
  id: number;
  name: string;
  sortOrder: number;
  createdAt: Date;
}

export async function listLabelCategories(
  db: DbOrTx,
  args: { limit: number; offset: number; orderBy: SQL },
): Promise<LabelCategoryRow[]> {
  return db
    .select({
      id: userLabelCategories.id,
      name: userLabelCategories.name,
      sortOrder: userLabelCategories.sortOrder,
      createdAt: userLabelCategories.createdAt,
    })
    .from(userLabelCategories)
    .orderBy(args.orderBy)
    .limit(args.limit)
    .offset(args.offset);
}

export async function countLabelCategories(db: DbOrTx): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(userLabelCategories);
  return rows[0]?.n ?? 0;
}

export async function findLabelCategory(db: DbOrTx, id: number): Promise<LabelCategoryRow | null> {
  const rows = await db
    .select({
      id: userLabelCategories.id,
      name: userLabelCategories.name,
      sortOrder: userLabelCategories.sortOrder,
      createdAt: userLabelCategories.createdAt,
    })
    .from(userLabelCategories)
    .where(eq(userLabelCategories.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertLabelCategory(
  tx: Tx,
  args: { name: string; sortOrder: number; now: Date },
): Promise<{ id: number } | null> {
  const rows = await tx
    .insert(userLabelCategories)
    .values({
      name: args.name,
      sortOrder: args.sortOrder,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoNothing()
    .returning({ id: userLabelCategories.id });
  return rows[0] ?? null;
}

export async function updateLabelCategory(
  tx: Tx,
  args: { id: number; name: string; sortOrder: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userLabelCategories, {
    where: eq(userLabelCategories.id, args.id),
    set: { name: args.name, sortOrder: args.sortOrder, updatedAt: args.now },
  });
}

export async function deleteLabelCategory(tx: Tx, id: number): Promise<ConditionalUpdateResult> {
  return conditionalDelete(tx, userLabelCategories, eq(userLabelCategories.id, id));
}

export interface LabelRow {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  name: string;
  sortOrder: number;
  createdAt: Date;
  memberCount: number;
}

const labelColumns = {
  id: userLabels.id,
  categoryId: userLabels.categoryId,
  categoryName: userLabelCategories.name,
  name: userLabels.name,
  sortOrder: userLabels.sortOrder,
  createdAt: userLabels.createdAt,
  memberCount: sql<number>`(select count(*)::int from ${userLabelsMap} where ${userLabelsMap.labelId} = ${userLabels.id})`,
} as const;

export async function listLabels(
  db: DbOrTx,
  args: LabelFilters & { limit: number; offset: number; orderBy: SQL },
): Promise<LabelRow[]> {
  return db
    .select(labelColumns)
    .from(userLabels)
    .leftJoin(userLabelCategories, eq(userLabels.categoryId, userLabelCategories.id))
    .where(labelWhere(args))
    .orderBy(args.orderBy)
    .limit(args.limit)
    .offset(args.offset);
}

export async function countLabels(db: DbOrTx, args: LabelFilters): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userLabels)
    .where(labelWhere(args));
  return rows[0]?.n ?? 0;
}

export interface LabelFilters {
  categoryId?: number | undefined;
  keyword?: string | undefined;
}

function labelWhere(args: LabelFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (args.categoryId !== undefined) conditions.push(eq(userLabels.categoryId, args.categoryId));
  if (args.keyword) conditions.push(ilike(userLabels.name, containsPattern(args.keyword)));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function findLabel(db: DbOrTx, id: number): Promise<LabelRow | null> {
  const rows = await db
    .select(labelColumns)
    .from(userLabels)
    .leftJoin(userLabelCategories, eq(userLabels.categoryId, userLabelCategories.id))
    .where(eq(userLabels.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertLabel(
  tx: Tx,
  args: { categoryId: number | null; name: string; sortOrder: number; now: Date },
): Promise<{ id: number } | null> {
  const rows = await tx
    .insert(userLabels)
    .values({
      categoryId: args.categoryId,
      name: args.name,
      sortOrder: args.sortOrder,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoNothing()
    .returning({ id: userLabels.id });
  return rows[0] ?? null;
}

export async function updateLabel(
  tx: Tx,
  args: { id: number; categoryId: number | null; name: string; sortOrder: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userLabels, {
    where: eq(userLabels.id, args.id),
    set: {
      categoryId: args.categoryId,
      name: args.name,
      sortOrder: args.sortOrder,
      updatedAt: args.now,
    },
  });
}

export async function deleteLabel(tx: Tx, id: number): Promise<ConditionalUpdateResult> {
  return conditionalDelete(tx, userLabels, eq(userLabels.id, id));
}

export async function existingGroupIds(db: DbOrTx, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(inArray(userGroups.id, ids));
  return rows.map((r) => r.id);
}

export async function existingLabelIds(db: DbOrTx, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: userLabels.id })
    .from(userLabels)
    .where(inArray(userLabels.id, ids));
  return rows.map((r) => r.id);
}

export async function existingUserIds(db: DbOrTx, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.deletedAt)));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// membership
// ---------------------------------------------------------------------------

export async function addGroupMemberships(
  tx: Tx,
  args: { userIds: number[]; groupIds: number[]; now: Date },
): Promise<void> {
  if (args.userIds.length === 0 || args.groupIds.length === 0) return;
  const values = args.userIds.flatMap((userId) =>
    args.groupIds.map((groupId) => ({ userId, groupId, createdAt: args.now })),
  );
  await tx.insert(userGroupsMap).values(values).onConflictDoNothing();
}

export async function removeGroupMemberships(
  tx: Tx,
  args: { userIds: number[]; groupIds?: number[] },
): Promise<void> {
  if (args.userIds.length === 0) return;
  const conditions: SQL[] = [inArray(userGroupsMap.userId, args.userIds)];
  if (args.groupIds) {
    if (args.groupIds.length === 0) return;
    conditions.push(inArray(userGroupsMap.groupId, args.groupIds));
  }
  await tx.delete(userGroupsMap).where(and(...conditions));
}

export async function addLabelMemberships(
  tx: Tx,
  args: { userIds: number[]; labelIds: number[]; now: Date },
): Promise<void> {
  if (args.userIds.length === 0 || args.labelIds.length === 0) return;
  const values = args.userIds.flatMap((userId) =>
    args.labelIds.map((labelId) => ({ userId, labelId, createdAt: args.now })),
  );
  await tx.insert(userLabelsMap).values(values).onConflictDoNothing();
}

export async function removeLabelMemberships(
  tx: Tx,
  args: { userIds: number[]; labelIds?: number[] },
): Promise<void> {
  if (args.userIds.length === 0) return;
  const conditions: SQL[] = [inArray(userLabelsMap.userId, args.userIds)];
  if (args.labelIds) {
    if (args.labelIds.length === 0) return;
    conditions.push(inArray(userLabelsMap.labelId, args.labelIds));
  }
  await tx.delete(userLabelsMap).where(and(...conditions));
}

/** Groups and labels for a page of customers, in one round trip each. */
export async function loadGroupsFor(
  db: DbOrTx,
  userIds: number[],
): Promise<Map<number, Array<{ id: number; name: string }>>> {
  const out = new Map<number, Array<{ id: number; name: string }>>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: userGroupsMap.userId, id: userGroups.id, name: userGroups.name })
    .from(userGroupsMap)
    .innerJoin(userGroups, eq(userGroupsMap.groupId, userGroups.id))
    .where(inArray(userGroupsMap.userId, userIds))
    .orderBy(asc(userGroups.sortOrder), asc(userGroups.id));
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({ id: row.id, name: row.name });
    out.set(row.userId, list);
  }
  return out;
}

export async function loadLabelsFor(
  db: DbOrTx,
  userIds: number[],
): Promise<Map<number, Array<{ id: number; name: string }>>> {
  const out = new Map<number, Array<{ id: number; name: string }>>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: userLabelsMap.userId, id: userLabels.id, name: userLabels.name })
    .from(userLabelsMap)
    .innerJoin(userLabels, eq(userLabelsMap.labelId, userLabels.id))
    .where(inArray(userLabelsMap.userId, userIds))
    .orderBy(asc(userLabels.sortOrder), asc(userLabels.id));
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({ id: row.id, name: row.name });
    out.set(row.userId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// admin list
// ---------------------------------------------------------------------------

export interface AdminListFilters {
  /** A substring of the account, the phone, the nickname or the real name. */
  keyword?: string | undefined;
  groupId?: number | undefined;
  labelId?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  registerSource?: 'h5' | 'wechat_oa' | 'wechat_mini' | 'admin' | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
  hasWechat?: boolean | undefined;
}

function adminListWhere(filters: AdminListFilters): SQL | undefined {
  const conditions: SQL[] = [isNull(users.deletedAt)];
  if (filters.keyword) {
    const like = containsPattern(filters.keyword);
    const keyword = or(
      ilike(users.account, like),
      ilike(users.phone, like),
      ilike(users.nickname, like),
      ilike(users.realName, like),
    );
    if (keyword) conditions.push(keyword);
  }
  if (filters.status) conditions.push(eq(users.status, filters.status));
  if (filters.registerSource) conditions.push(eq(users.registerSource, filters.registerSource));
  if (filters.createdFrom) conditions.push(gte(users.createdAt, filters.createdFrom));
  if (filters.createdTo) conditions.push(lte(users.createdAt, filters.createdTo));
  if (filters.groupId !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${userGroupsMap} where ${userGroupsMap.userId} = ${users.id} and ${userGroupsMap.groupId} = ${filters.groupId})`,
    );
  }
  if (filters.labelId !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${userLabelsMap} where ${userLabelsMap.userId} = ${users.id} and ${userLabelsMap.labelId} = ${filters.labelId})`,
    );
  }
  if (filters.hasWechat !== undefined) {
    const exists = sql`exists (select 1 from ${wechatIdentities} where ${wechatIdentities.userId} = ${users.id})`;
    conditions.push(filters.hasWechat ? exists : sql`not ${exists}`);
  }
  return and(...conditions);
}

export async function listUsers(
  db: DbOrTx,
  args: AdminListFilters & { limit: number; offset: number; orderBy: SQL },
): Promise<UserRow[]> {
  const rows = await db
    .select(userColumns)
    .from(users)
    .where(adminListWhere(args))
    .orderBy(args.orderBy)
    .limit(args.limit)
    .offset(args.offset);
  return rows as UserRow[];
}

/**
 * The ids of the users the 客户列表's filters match, lowest first, at most
 * `limit`. For 按筛选发券, which asks for one more than it allows to learn that
 * an audience is too big without counting all of it.
 */
export async function userIdsMatching(
  db: DbOrTx,
  filters: AdminListFilters,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(adminListWhere(filters))
    .orderBy(asc(users.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function countUsers(db: DbOrTx, filters: AdminListFilters): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(adminListWhere(filters));
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// cancellation requests
// ---------------------------------------------------------------------------

export interface CancellationRow {
  id: number;
  userId: number;
  nickname: string | null;
  phone: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reviewRemark: string | null;
  reviewedByAdminId: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

const cancellationColumns = {
  id: userCancellationRequests.id,
  userId: userCancellationRequests.userId,
  nickname: userCancellationRequests.nickname,
  phone: userCancellationRequests.phone,
  reason: userCancellationRequests.reason,
  status: userCancellationRequests.status,
  reviewRemark: userCancellationRequests.reviewRemark,
  reviewedByAdminId: userCancellationRequests.reviewedByAdminId,
  reviewedAt: userCancellationRequests.reviewedAt,
  createdAt: userCancellationRequests.createdAt,
} as const;

/**
 * File a request.
 *
 * `null` means `user_cancellation_requests_open_uq` refused it — the customer
 * already has one pending. That is the whole concurrency control: no read, no
 * lock, just the partial unique index doing its job.
 */
export async function insertCancellation(
  tx: Tx,
  args: {
    userId: number;
    nickname: string | null;
    phone: string | null;
    reason: string | null;
    now: Date;
  },
): Promise<CancellationRow | null> {
  const rows = await tx
    .insert(userCancellationRequests)
    .values({
      userId: args.userId,
      nickname: args.nickname,
      phone: args.phone,
      reason: args.reason,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoNothing()
    .returning(cancellationColumns);
  return rows[0] ?? null;
}

export async function findPendingCancellation(
  db: DbOrTx,
  userId: number,
): Promise<CancellationRow | null> {
  const rows = await db
    .select(cancellationColumns)
    .from(userCancellationRequests)
    .where(
      and(
        eq(userCancellationRequests.userId, userId),
        eq(userCancellationRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findCancellation(db: DbOrTx, id: number): Promise<CancellationRow | null> {
  const rows = await db
    .select(cancellationColumns)
    .from(userCancellationRequests)
    .where(eq(userCancellationRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Decide a request.
 *
 * `status = 'pending'` is in the WHERE, so two operators clicking 同意 at the
 * same instant produce one approval and one `USER_CANCELLATION_NOT_PENDING` —
 * and, more importantly, the anonymisation that follows runs exactly once.
 */
export async function decideCancellation(
  tx: Tx,
  args: {
    id: number;
    status: 'approved' | 'rejected' | 'withdrawn';
    adminId: number | null;
    remark: string | null;
    now: Date;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userCancellationRequests, {
    where: and(
      eq(userCancellationRequests.id, args.id),
      eq(userCancellationRequests.status, 'pending'),
    ),
    set: {
      status: args.status,
      reviewedByAdminId: args.adminId,
      ...(args.remark === null ? {} : { reviewRemark: args.remark }),
      reviewedAt: args.now,
      updatedAt: args.now,
    },
  });
}

export async function remarkCancellation(
  tx: Tx,
  args: { id: number; remark: string; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userCancellationRequests, {
    where: eq(userCancellationRequests.id, args.id),
    set: { reviewRemark: args.remark, updatedAt: args.now },
  });
}

function cancellationWhere(filters: {
  status?: 'pending' | 'approved' | 'rejected' | 'withdrawn' | undefined;
  keyword?: string | undefined;
}): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.status) conditions.push(eq(userCancellationRequests.status, filters.status));
  if (filters.keyword) {
    const like = containsPattern(filters.keyword);
    const keyword = or(
      ilike(userCancellationRequests.nickname, like),
      ilike(userCancellationRequests.phone, like),
    );
    if (keyword) conditions.push(keyword);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listCancellations(
  db: DbOrTx,
  args: {
    status?: 'pending' | 'approved' | 'rejected' | 'withdrawn' | undefined;
    keyword?: string | undefined;
    limit: number;
    offset: number;
    orderBy: SQL;
  },
): Promise<CancellationRow[]> {
  return db
    .select(cancellationColumns)
    .from(userCancellationRequests)
    .where(cancellationWhere(args))
    .orderBy(args.orderBy)
    .limit(args.limit)
    .offset(args.offset);
}

export async function countCancellations(
  db: DbOrTx,
  filters: {
    status?: 'pending' | 'approved' | 'rejected' | 'withdrawn' | undefined;
    keyword?: string | undefined;
  },
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userCancellationRequests)
    .where(cancellationWhere(filters));
  return rows[0]?.n ?? 0;
}

/** Sort expressions the services may pass, named so no caller builds raw SQL. */
export const orderBy = {
  users: {
    id: { asc: asc(users.id), desc: desc(users.id) },
    createdAt: { asc: asc(users.createdAt), desc: desc(users.createdAt) },
    lastLoginAt: { asc: asc(users.lastLoginAt), desc: desc(users.lastLoginAt) },
  },
  groups: {
    id: { asc: asc(userGroups.id), desc: desc(userGroups.id) },
    name: { asc: asc(userGroups.name), desc: desc(userGroups.name) },
    sortOrder: { asc: asc(userGroups.sortOrder), desc: desc(userGroups.sortOrder) },
  },
  labelCategories: {
    id: { asc: asc(userLabelCategories.id), desc: desc(userLabelCategories.id) },
    name: { asc: asc(userLabelCategories.name), desc: desc(userLabelCategories.name) },
    sortOrder: {
      asc: asc(userLabelCategories.sortOrder),
      desc: desc(userLabelCategories.sortOrder),
    },
  },
  labels: {
    id: { asc: asc(userLabels.id), desc: desc(userLabels.id) },
    name: { asc: asc(userLabels.name), desc: desc(userLabels.name) },
    sortOrder: { asc: asc(userLabels.sortOrder), desc: desc(userLabels.sortOrder) },
  },
  cancellations: {
    id: { asc: asc(userCancellationRequests.id), desc: desc(userCancellationRequests.id) },
    createdAt: {
      asc: asc(userCancellationRequests.createdAt),
      desc: desc(userCancellationRequests.createdAt),
    },
  },
} as const;
