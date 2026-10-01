import type { DbOrTx } from '@shop/db';
import type {
  ApiTokenCreateBody,
  ApiTokenItem,
} from '@shop/contracts/auth/auth.api-token.contract';
import type { Clock } from '../kernel/clock';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, randomToken, toId } from '../kernel/ids';
import * as adminRepo from './admin.repo';
import * as tokenRepo from './api-token.repo';
import { sha256Hex } from './password';
import { effectivePermissions } from './rbac';

/**
 * API tokens — how an admin acts from outside the console: an AI agent over
 * MCP (`/mcp`), the `shop` CLI, anything that can send a header.
 *
 * A token is `Authorization: Bearer shp_…` on `/admin-api/**` and goes through
 * `handle()` like a cookie: same validation, same permission check, same audit
 * row (with `api_token_id` set). It acts as its admin with the admin's roles
 * *as they are now* — nothing about permissions is copied into the token.
 *
 * Tokens are managed only from a console session. A token that could mint
 * tokens would let an agent that was handed one keep access after it is
 * revoked.
 */

export const API_TOKEN_PREFIX = 'shp_';
export const REFRESH_TOKEN_PREFIX = 'shr_';

/** OAuth access tokens are short; the client refreshes them without asking anyone. */
export const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
/** Idle limit of an OAuth grant: unused this long, the client must sign in again. */
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ResolvedApiToken {
  tokenId: number;
  tokenName: string;
  adminId: number;
  account: string;
  isSuper: boolean;
  permissions: string[];
}

/** True for anything shaped like one of ours, so `handle()` knows which resolver to ask. */
export function isApiToken(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX);
}

function mint(prefix: string): { token: string; hash: string; hint: string } {
  const token = `${prefix}${randomToken(40)}`;
  return { token, hash: sha256Hex(token), hint: token.slice(0, 10) };
}

/**
 * Resolves a bearer token to the admin it acts as, or `null`. Two reads (the
 * token joined to its admin, then the admin's grants) and at most one write a
 * minute for `last_used_at`.
 */
export async function resolveApiToken(
  deps: { db: DbOrTx; clock: Clock },
  token: string,
  meta: { ip: string | null } = { ip: null },
): Promise<ResolvedApiToken | null> {
  if (!isApiToken(token) || token.length > 128) return null;
  const now = deps.clock.now();
  const row = await tokenRepo.findLive(deps.db, sha256Hex(token), now);
  if (!row) return null;
  const granted = row.isSuper ? [] : await adminRepo.loadPermissions(deps.db, row.adminId);
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await tokenRepo.touch(deps.db, row.id, meta.ip?.slice(0, 64) ?? null, now);
  }
  return {
    tokenId: row.id,
    tokenName: row.name,
    adminId: row.adminId,
    account: row.account,
    isSuper: row.isSuper,
    permissions: effectivePermissions(granted),
  };
}

/** A console session, not a token, and an admin at that. */
function requireConsole(ctx: Ctx): number {
  if (ctx.actor.kind !== 'admin' || ctx.actor.id === null) throw new DomainError('UNAUTHENTICATED');
  if (ctx.actor.apiTokenId !== undefined) throw new DomainError('AUTH_TOKEN_CONSOLE_ONLY');
  return ctx.actor.id;
}

async function passwordVersionOf(db: DbOrTx, adminId: number): Promise<number> {
  const admin = await adminRepo.findById(db, adminId);
  if (!admin || admin.status !== 1) throw new DomainError('AUTH_SESSION_EXPIRED');
  return admin.passwordVersion;
}

/** The row as `auth.apiTokenList` shows it. */
export function toApiTokenItem(row: tokenRepo.ApiTokenRow): ApiTokenItem {
  return {
    id: toId(row.id),
    name: row.name,
    kind: row.kind,
    hint: row.hint,
    adminId: toId(row.adminId),
    adminAccount: row.adminAccount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 「新建令牌」: a personal token for a client that takes a header. The plain value is returned once. */
export async function createPersonalToken(
  ctx: Ctx,
  input: ApiTokenCreateBody,
): Promise<{ item: ApiTokenItem; token: string }> {
  const adminId = requireConsole(ctx);
  const now = ctx.clock.now();
  const minted = mint(API_TOKEN_PREFIX);
  const id = await tokenRepo.insert(ctx.db, {
    adminId,
    name: input.name.trim(),
    kind: 'pat',
    tokenHash: minted.hash,
    hint: minted.hint,
    refreshHash: null,
    clientId: null,
    passwordVersion: await passwordVersionOf(ctx.db, adminId),
    expiresAt:
      input.expiresInDays === null
        ? null
        : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000),
    refreshExpiresAt: null,
    now,
  });
  const row = await tokenRepo.findById(ctx.db, id);
  if (!row) throw new Error('admin_api_tokens: inserted row not found');
  return { item: toApiTokenItem(row), token: minted.token };
}

/** Own tokens; the super admin sees everybody's. */
export async function listTokens(ctx: Ctx): Promise<{ items: ApiTokenItem[] }> {
  const adminId = requireConsole(ctx);
  const rows = await tokenRepo.list(ctx.db, ctx.actor.isSuper ? null : adminId);
  return { items: rows.map(toApiTokenItem) };
}

/** Own tokens; the super admin anybody's. Revoking twice is fine. */
export async function revokeToken(ctx: Ctx, params: { id: string }): Promise<void> {
  const adminId = requireConsole(ctx);
  const id = fromId(params.id);
  const row = await tokenRepo.findById(ctx.db, id);
  if (!row || (row.adminId !== adminId && !ctx.actor.isSuper)) throw new DomainError('NOT_FOUND');
  await tokenRepo.revoke(ctx.db, id, ctx.clock.now());
}

// -- OAuth grants ---------------------------------------------------------------

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/** The grant `/oauth/token` hands out for a redeemed authorization code. */
export async function issueOAuthGrant(
  deps: { db: DbOrTx; clock: Clock },
  input: { adminId: number; clientId: string; clientName: string },
): Promise<OAuthTokenSet> {
  const now = deps.clock.now();
  const access = mint(API_TOKEN_PREFIX);
  const refresh = mint(REFRESH_TOKEN_PREFIX);
  await tokenRepo.insert(deps.db, {
    adminId: input.adminId,
    name: input.clientName.slice(0, 64),
    kind: 'oauth',
    tokenHash: access.hash,
    hint: access.hint,
    refreshHash: refresh.hash,
    clientId: input.clientId,
    passwordVersion: await passwordVersionOf(deps.db, input.adminId),
    expiresAt: new Date(now.getTime() + OAUTH_ACCESS_TTL_MS),
    refreshExpiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_MS),
    now,
  });
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresInSeconds: OAUTH_ACCESS_TTL_MS / 1000,
  };
}

/**
 * `grant_type=refresh_token`: rotates both secrets. The old refresh token is
 * dead afterwards; `null` means "sign in again" (`invalid_grant`).
 */
export async function refreshOAuthGrant(
  deps: { db: DbOrTx; clock: Clock },
  input: { refreshToken: string; clientId: string },
): Promise<OAuthTokenSet | null> {
  if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  const now = deps.clock.now();
  const fromHash = sha256Hex(input.refreshToken);
  const grant = await tokenRepo.findByRefresh(deps.db, fromHash, now);
  if (!grant || grant.clientId !== input.clientId) return null;
  const access = mint(API_TOKEN_PREFIX);
  const refresh = mint(REFRESH_TOKEN_PREFIX);
  const rotated = await tokenRepo.rotate(deps.db, grant.id, {
    fromRefreshHash: fromHash,
    tokenHash: access.hash,
    hint: access.hint,
    refreshHash: refresh.hash,
    expiresAt: new Date(now.getTime() + OAUTH_ACCESS_TTL_MS),
    refreshExpiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_MS),
  });
  if (!rotated) return null;
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresInSeconds: OAUTH_ACCESS_TTL_MS / 1000,
  };
}
