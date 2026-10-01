import type { ClientPlatform } from '@shop/contracts/conventions';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { randomToken } from '../kernel/ids';
import { sha256Hex } from './password';
import { getUserLookup } from './user-lookup';
import * as repo from './user-session.repo';

/**
 * Storefront sessions.
 *
 * Two properties matter here:
 *
 *  - a token is bound to the password — a session records the `passwordVersion`
 *    it was minted with and is refused the moment the user's current version
 *    differs, so changing a password really does log every device out;
 *  - the token itself is never stored. `user_sessions.token_hash` holds
 *    `sha256(token)`, so a database dump cannot be replayed against the API.
 *
 * Unlike admin sessions these live in PostgreSQL: a shopper's phone must stay
 * logged in for weeks, across a Redis restart, and "log out my other devices"
 * has to be a real query.
 */

export const DEFAULT_USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueInput {
  userId: number;
  passwordVersion: number;
  platform: ClientPlatform;
  userAgent?: string | null;
  ttlMs?: number;
}

export interface IssuedSession {
  /** The bearer token. Returned to the client once and never stored in the clear. */
  token: string;
  sessionId: number;
  expiresAt: Date;
}

export interface ResolvedSession {
  sessionId: number;
  userId: number;
  platform: string;
}

export class UserSessionService {
  constructor(private readonly ttlMs: number = DEFAULT_USER_SESSION_TTL_MS) {}

  async issue(ctx: Ctx, input: IssueInput): Promise<IssuedSession> {
    const token = randomToken(48);
    const now = ctx.clock.now();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? this.ttlMs));
    const sessionId = await repo.insert(ctx.db, {
      userId: input.userId,
      tokenHash: sha256Hex(token),
      passwordVersion: input.passwordVersion,
      platform: input.platform,
      userAgent: (input.userAgent ?? null)?.slice(0, 255) ?? null,
      expiresAt,
      now,
    });
    return { token, sessionId, expiresAt };
  }

  /**
   * Resolves a bearer token. Returns `null` for every "not logged in" reason —
   * unknown token, expired, revoked, stale `passwordVersion`, disabled user —
   * because the client's only sensible reaction to all of them is to log in
   * again, and distinguishing them tells an attacker which tokens once existed.
   */
  async resolve(ctx: Ctx, token: string): Promise<ResolvedSession | null> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
    const now = ctx.clock.now();
    const session = await repo.findLive(ctx.db, sha256Hex(token), now);
    if (!session) return null;

    const lookup = getUserLookup();
    if (!lookup) {
      // Fail closed. A missing `UserLookup` means the `user` domain did not
      // load, and we cannot prove the session is still valid.
      ctx.logger.error('UserLookup 未注册，商城会话无法校验');
      return null;
    }
    const user = await lookup.findAuthState(ctx.db, session.userId);
    if (!user || user.status !== 1) return null;
    if (user.passwordVersion !== session.passwordVersion) {
      // Password changed after this token was minted: revoke it on sight so the
      // row stops being resolved even before the housekeeping job runs.
      await repo.revokeByHash(ctx.db, sha256Hex(token), now);
      return null;
    }

    await repo.touch(ctx.db, session.id, now);
    return { sessionId: session.id, userId: session.userId, platform: session.platform };
  }

  async revoke(ctx: Ctx, token: string): Promise<void> {
    await repo.revokeByHash(ctx.db, sha256Hex(token), ctx.clock.now());
  }

  async revokeAllForUser(ctx: Ctx, userId: number): Promise<number> {
    return repo.revokeAllForUser(ctx.db, userId, ctx.clock.now());
  }

  /** Housekeeping job (`system.pruneSessions`). */
  async pruneExpired(ctx: Ctx): Promise<number> {
    return repo.deleteExpired(ctx.db, ctx.clock.now());
  }
}

/** Reads the `Authorization: Bearer <token>` header, or throws 401. */
export function requireBearer(header: string | null | undefined): string {
  const token = readBearer(header);
  if (!token) throw new DomainError('UNAUTHENTICATED');
  return token;
}

export function readBearer(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
