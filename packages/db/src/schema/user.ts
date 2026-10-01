import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, instant, pk, updatedAt } from './_shared';
import { admins } from './auth';
import { cities } from './reference';

/**
 * Storefront customers and everything hanging off them.
 *
 * Deliberately absent (retired with the features that used them): balance,
 * points, experience, member level, referrer / distribution chain, sign-in
 * streak, agent / staff / division flags, partner id. A customer is an
 * identity with addresses, labels and invoice profiles — nothing more.
 *
 * Admin accounts and *all* session tables belong to `auth.ts`.
 */

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** How `passwordHash` was produced. Imported MD5 hashes are upgraded on first successful login. */
export const usersPasswordAlgo = pgEnum('users_password_algo', ['bcrypt', 'md5_legacy']);

export const usersStatus = pgEnum('users_status', ['active', 'disabled']);

export const usersRegisterSource = pgEnum('users_register_source', [
  'h5',
  'wechat_oa',
  'wechat_mini',
  'admin',
]);

export const users = pgTable(
  'users',
  {
    id: pk(),
    /** Login name. Usually the phone number, but it is a distinct identity column. */
    account: varchar({ length: 64 }).notNull(),
    /** Mainland mobile number, digits only. NULL when the account has never bound one. */
    phone: varchar({ length: 20 }),
    /** NULL for accounts that can only sign in with an SMS code or a WeChat identity. */
    passwordHash: varchar({ length: 255 }),
    passwordAlgo: usersPasswordAlgo(),
    /**
     * Bumped on every password or status change. Storefront sessions carry the
     * value they were minted with, so a bump revokes every live session.
     */
    passwordVersion: integer().notNull().default(1),
    nickname: varchar({ length: 64 }),
    avatarUrl: varchar({ length: 512 }),
    realName: varchar({ length: 32 }),
    birthday: instant(),
    /** Operator-only note. Never shown to the customer. */
    adminRemark: varchar({ length: 255 }),
    status: usersStatus().notNull().default('active'),
    registerSource: usersRegisterSource(),
    registerIp: varchar({ length: 45 }),
    lastLoginAt: instant(),
    lastLoginIp: varchar({ length: 45 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Set when an account-cancellation request is approved. */
    deletedAt: deletedAt(),
  },
  (t) => [
    // Logins are case-insensitive; PostgreSQL comparisons are not, so the
    // uniqueness has to be expressed on the folded value.
    uniqueIndex('users_account_lower_uq').on(sql`lower(${t.account})`),
    uniqueIndex('users_phone_lower_uq').on(sql`lower(${t.phone})`),
    index('users_status_idx').on(t.status),
    index('users_created_at_idx').on(t.createdAt),
    check('users_password_version_positive', sql`${t.passwordVersion} >= 1`),
    // A hash without an algorithm (or the reverse) cannot be verified.
    check('users_password_pair', sql`(${t.passwordHash} is null) = (${t.passwordAlgo} is null)`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

export const userAddresses = pgTable(
  'user_addresses',
  {
    id: pk(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    receiverName: varchar({ length: 32 }).notNull(),
    receiverPhone: varchar({ length: 20 }).notNull(),
    /** Division ids; NULL when the address predates the city tree or was typed free-form. */
    provinceId: fk().references(() => cities.id, { onDelete: 'set null' }),
    cityId: fk().references(() => cities.id, { onDelete: 'set null' }),
    districtId: fk().references(() => cities.id, { onDelete: 'set null' }),
    /** Names frozen at save time so a later rename of a division does not rewrite history. */
    provinceName: varchar({ length: 64 }).notNull(),
    cityName: varchar({ length: 64 }).notNull(),
    districtName: varchar({ length: 64 }),
    detail: varchar({ length: 255 }).notNull(),
    postCode: varchar({ length: 10 }),
    lng: numeric({ precision: 10, scale: 6 }),
    lat: numeric({ precision: 10, scale: 6 }),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('user_addresses_user_idx').on(t.userId),
    // At most one live default address per user, enforced by the database
    // rather than by a read-then-write in the service.
    uniqueIndex('user_addresses_default_uq')
      .on(t.userId)
      .where(sql`is_default and deleted_at is null`),
  ],
);

export type UserAddress = typeof userAddresses.$inferSelect;
export type NewUserAddress = typeof userAddresses.$inferInsert;

// ---------------------------------------------------------------------------
// groups and labels
// ---------------------------------------------------------------------------

export const userGroups = pgTable(
  'user_groups',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_groups_name_uq').on(t.name)],
);

export type UserGroup = typeof userGroups.$inferSelect;
export type NewUserGroup = typeof userGroups.$inferInsert;

/** Join table: a user may belong to several groups. */
export const userGroupsMap = pgTable(
  'user_groups_map',
  {
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: fk()
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.groupId] }),
    index('user_groups_map_group_idx').on(t.groupId),
  ],
);

export type UserGroupsMapRow = typeof userGroupsMap.$inferSelect;
export type NewUserGroupsMapRow = typeof userGroupsMap.$inferInsert;

export const userLabelCategories = pgTable(
  'user_label_categories',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_label_categories_name_uq').on(t.name)],
);

export type UserLabelCategory = typeof userLabelCategories.$inferSelect;
export type NewUserLabelCategory = typeof userLabelCategories.$inferInsert;

export const userLabels = pgTable(
  'user_labels',
  {
    id: pk(),
    categoryId: fk().references(() => userLabelCategories.id, { onDelete: 'set null' }),
    name: varchar({ length: 64 }).notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_labels_name_uq').on(t.name),
    index('user_labels_category_idx').on(t.categoryId),
  ],
);

export type UserLabel = typeof userLabels.$inferSelect;
export type NewUserLabel = typeof userLabels.$inferInsert;

export const userLabelsMap = pgTable(
  'user_labels_map',
  {
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    labelId: fk()
      .notNull()
      .references(() => userLabels.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.labelId] }),
    index('user_labels_map_label_idx').on(t.labelId),
  ],
);

export type UserLabelsMapRow = typeof userLabelsMap.$inferSelect;
export type NewUserLabelsMapRow = typeof userLabelsMap.$inferInsert;

// ---------------------------------------------------------------------------
// invoice profiles
// ---------------------------------------------------------------------------

export const userInvoiceProfilesHeaderType = pgEnum('user_invoice_profiles_header_type', [
  'personal',
  'company',
]);

export const userInvoiceProfilesInvoiceType = pgEnum('user_invoice_profiles_invoice_type', [
  'plain',
  'special',
]);

/** The saved "invoice title" a customer picks from when asking for an invoice. */
export const userInvoiceProfiles = pgTable(
  'user_invoice_profiles',
  {
    id: pk(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    headerType: userInvoiceProfilesHeaderType().notNull(),
    invoiceType: userInvoiceProfilesInvoiceType().notNull().default('plain'),
    name: varchar({ length: 100 }).notNull(),
    /** Unified social credit code. Required for company headers. */
    dutyNumber: varchar({ length: 50 }),
    drawerPhone: varchar({ length: 20 }),
    email: varchar({ length: 100 }),
    registeredTel: varchar({ length: 30 }),
    registeredAddress: varchar({ length: 255 }),
    bankName: varchar({ length: 100 }),
    bankAccount: varchar({ length: 50 }),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('user_invoice_profiles_user_idx').on(t.userId),
    uniqueIndex('user_invoice_profiles_default_uq')
      .on(t.userId)
      .where(sql`is_default and deleted_at is null`),
    check(
      'user_invoice_profiles_company_needs_duty_number',
      sql`${t.headerType} <> 'company' or ${t.dutyNumber} is not null`,
    ),
  ],
);

export type UserInvoiceProfile = typeof userInvoiceProfiles.$inferSelect;
export type NewUserInvoiceProfile = typeof userInvoiceProfiles.$inferInsert;

// ---------------------------------------------------------------------------
// account cancellation
// ---------------------------------------------------------------------------

export const userCancellationRequestsStatus = pgEnum('user_cancellation_requests_status', [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
]);

export const userCancellationRequests = pgTable(
  'user_cancellation_requests',
  {
    id: pk(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Frozen at request time; the user row may be anonymised on approval. */
    nickname: varchar({ length: 64 }),
    phone: varchar({ length: 20 }),
    reason: text(),
    status: userCancellationRequestsStatus().notNull().default('pending'),
    reviewRemark: varchar({ length: 255 }),
    reviewedByAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    reviewedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('user_cancellation_requests_status_idx').on(t.status, t.createdAt),
    // A customer can only have one open request at a time.
    uniqueIndex('user_cancellation_requests_open_uq')
      .on(t.userId)
      .where(sql`status = 'pending'`),
  ],
);

export type UserCancellationRequest = typeof userCancellationRequests.$inferSelect;
export type NewUserCancellationRequest = typeof userCancellationRequests.$inferInsert;
