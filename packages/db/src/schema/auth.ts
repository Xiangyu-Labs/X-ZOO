import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, fk, instant, pk, updatedAt } from './_shared';
import { users } from './user';

/**
 * Admin identities, RBAC and storefront sessions.
 *
 * RBAC lives entirely in these four tables: permission *atoms* are declared in
 * code (`core/<domain>/permissions.ts`) and only the grants are stored, so a
 * renamed atom is a code change plus a data fix-up, never a migration.
 */

export const admins = pgTable(
  'admins',
  {
    id: pk(),
    /** Login name. Unique case-insensitively — PostgreSQL, unlike MySQL, is case-sensitive. */
    account: varchar({ length: 64 }).notNull(),
    /** bcrypt hash, or an imported 32-char MD5 while `passwordAlgo = 'md5'`. */
    passwordHash: varchar({ length: 255 }).notNull(),
    /** `md5` rows are upgraded to bcrypt on the next successful login. */
    passwordAlgo: varchar({ length: 16 }).notNull().default('bcrypt'),
    /**
     * Bumped on every password change. Sessions carry the value they were
     * minted with and are rejected once it differs, which is what makes
     * "change password revokes everywhere" work without a session sweep.
     */
    passwordVersion: integer().notNull().default(1),
    name: varchar({ length: 64 }).notNull(),
    avatar: varchar({ length: 512 }),
    phone: varchar({ length: 32 }),
    /** Bypasses every permission check. Exactly one row should have it. */
    isSuper: boolean().notNull().default(false),
    status: smallint().notNull().default(1),
    lastLoginAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('admins_account_lower_key').on(sql`lower(${t.account})`)],
);

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    remark: varchar({ length: 255 }),
    status: smallint().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_name_key').on(t.name)],
);

/**
 * One row per granted atom. The atom string is *not* a foreign key: the set of
 * atoms is compiled into the app, and a role that still grants a retired atom
 * simply grants nothing.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: fk()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    /** `<domain>:<resource>:<action>`, e.g. `catalog:product:update`. */
    permission: varchar({ length: 128 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const adminRoles = pgTable(
  'admin_roles',
  {
    adminId: fk()
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    roleId: fk()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.adminId, t.roleId] }),
    index('admin_roles_role_idx').on(t.roleId),
  ],
);

/**
 * Storefront sessions. The admin surface keeps its sessions in Redis (a cookie
 * is cheap to re-issue); storefront tokens must survive a Redis flush and must
 * be revocable per user, so they live here.
 *
 * Only `sha256(token)` is stored. A dump of this table cannot be replayed.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: pk(),
    userId: fk()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    /** Lowercase hex sha256 of the opaque bearer token. */
    tokenHash: varchar({ length: 64 }).notNull(),
    /** Snapshot of `users.password_version` when the session was minted. */
    passwordVersion: integer().notNull().default(1),
    /** `h5` | `wechat-oa` | `wechat-mini`, from the `X-Client-Platform` header. */
    platform: varchar({ length: 24 }).notNull(),
    userAgent: varchar({ length: 255 }),
    expiresAt: instant().notNull(),
    lastSeenAt: instant(),
    revokedAt: instant(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_sessions_token_hash_key').on(t.tokenHash),
    index('user_sessions_user_idx').on(t.userId),
    index('user_sessions_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Admin operation log. Written by `handle()` for every mutating admin route
 * that succeeds, plus explicitly by services for things worth a sentence.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    adminId: fk().references(() => admins.id, { onDelete: 'set null' }),
    adminAccount: varchar({ length: 64 }).notNull(),
    /** Route id from the contract, e.g. `coupon.adminCreate`. */
    routeId: varchar({ length: 128 }).notNull(),
    method: varchar({ length: 8 }).notNull(),
    path: varchar({ length: 512 }).notNull(),
    /** Target of the operation when the service knows it, e.g. `coupon:42`. */
    target: varchar({ length: 128 }),
    status: integer().notNull(),
    /** Request body with secrets stripped. Never the raw body. */
    payload: text(),
    requestId: varchar({ length: 64 }).notNull(),
    /** Forwarded client address. Everything is behind one proxy, so this is advisory. */
    ip: varchar({ length: 64 }),
    /**
     * Who acted: `admin` — a console account, `admin_id` — or
     * `staff` — a 店员 on the mobile staff console, `user_id` (that console was
     * deleted at the cutover, so only historic rows carry it). Rows written
     * before the column existed are all console rows, hence the default.
     */
    actorKind: varchar({ length: 16 }).notNull().default('admin'),
    /** The 店员's storefront user when `actor_kind = 'staff'`. */
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    /**
     * Set when the admin acted through an API token (an agent over MCP, the
     * CLI) rather than the console. `admin_id` still names the admin: a token
     * acts as its owner, never as somebody of its own.
     */
    apiTokenId: fk().references((): AnyPgColumn => adminApiTokens.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_admin_idx').on(t.adminId, t.createdAt),
    index('audit_logs_route_idx').on(t.routeId, t.createdAt),
    index('audit_logs_user_idx').on(t.userId, t.createdAt),
    check('audit_logs_actor_kind_known', sql`${t.actorKind} in ('admin', 'staff')`),
  ],
);

/**
 * API tokens: an admin acting from somewhere other than the console — an AI
 * agent over MCP, the `shop` CLI.
 *
 * A token acts as its admin, with the admin's *current* roles: nothing about
 * permissions is stored here, so a role change or a disabled account takes
 * effect on the next request. A password change kills every token (the row
 * keeps the `password_version` it was minted under), as it kills every console
 * session.
 *
 * Two kinds:
 * - `pat`   made by hand on 「API 令牌」, pasted into a client that takes a header;
 * - `oauth` one row per grant a client obtained through `/oauth/authorize`.
 *           The access token is short-lived and rotated together with the
 *           refresh token on every refresh, so the row is the grant — revoking
 *           it disconnects that client.
 *
 * Only `sha256(token)` is stored.
 */
export const adminApiTokens = pgTable(
  'admin_api_tokens',
  {
    id: pk(),
    adminId: fk()
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    /** What the admin called it, or the OAuth client's name. */
    name: varchar({ length: 64 }).notNull(),
    kind: varchar({ length: 8 }).notNull(),
    /** Lowercase hex sha256 of the bearer token. */
    tokenHash: varchar({ length: 64 }).notNull(),
    /** The first characters of the token, so the list can tell two apart. */
    hint: varchar({ length: 16 }).notNull(),
    /** `oauth` only: sha256 of the current refresh token. */
    refreshHash: varchar({ length: 64 }),
    /** `oauth` only: the registered client this grant belongs to. */
    clientId: varchar({ length: 64 }),
    /** Snapshot of `admins.password_version` when minted. */
    passwordVersion: integer().notNull(),
    /** `null` for a PAT that never expires. */
    expiresAt: instant(),
    refreshExpiresAt: instant(),
    lastUsedAt: instant(),
    lastUsedIp: varchar({ length: 64 }),
    revokedAt: instant(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('admin_api_tokens_token_hash_key').on(t.tokenHash),
    uniqueIndex('admin_api_tokens_refresh_hash_key').on(t.refreshHash),
    index('admin_api_tokens_admin_idx').on(t.adminId),
    check('admin_api_tokens_kind_known', sql`${t.kind} in ('pat', 'oauth')`),
  ],
);

/**
 * OAuth clients registered through `/oauth/register` (RFC 7591), which is how
 * an MCP client (Claude, ChatGPT, …) introduces itself before the first
 * sign-in. Public clients only: no secret, PKCE is mandatory.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: pk(),
    clientId: varchar({ length: 64 }).notNull(),
    name: varchar({ length: 128 }).notNull(),
    /** Exact-match allow-list, as registered. */
    redirectUris: jsonb().$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('oauth_clients_client_id_key').on(t.clientId)],
);
