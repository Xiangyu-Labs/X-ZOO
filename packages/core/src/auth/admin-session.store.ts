import type Redis from 'ioredis';
import { randomToken } from '../kernel/ids';
import { sha256Hex } from './password';

/**
 * Admin sessions live in Redis.
 *
 * The admin surface is a cookie-auth SPA behind our own edge: a session is
 * cheap to re-issue, is never needed on a second device, and does not have to
 * survive a Redis flush (worst case: everybody logs in again). Storefront
 * sessions are the opposite and live in PostgreSQL — see `user-session.service.ts`.
 *
 * What is stored is `{ adminId, passwordVersion, permissions, isSuper }`, so a
 * request costs one Redis GET and no database round-trip. Changing a password
 * bumps `password_version` *and* calls `revokeAllForAdmin`, which deletes every
 * token in the per-admin index. **The index is the only belt**: nothing on the
 * request path compares `passwordVersion` with the admin row (that would be a
 * database read per request). So the index must list every live session for as
 * long as it lives — `resolve()` slides the index together with the session and
 * re-adds the session to it (otherwise a session kept alive past the index's
 * own TTL would fall out of it and survive a password change).
 *
 * The token is stored hashed, exactly as on the storefront: a Redis dump must
 * not be replayable.
 */

export interface AdminSession {
  adminId: number;
  account: string;
  name: string;
  avatar: string | null;
  isSuper: boolean;
  permissions: string[];
  passwordVersion: number;
  createdAt: number;
  /**
   * 「记住登录状态」: the session lives `REMEMBERED_ADMIN_SESSION_TTL_MS` idle
   * instead of the store's TTL, and its cookie is a persistent one. Absent on
   * sessions created before the flag existed, which then keep the store's TTL.
   */
  remember?: boolean;
}

export interface AdminSessionStoreOptions {
  redis: Redis;
  /** Sliding lifetime. Refreshed on every successful resolve. */
  ttlMs?: number;
  keyPrefix?: string;
}

/** Idle lifetime of a session: eight hours without a request and it is gone. */
export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Idle lifetime of a session signed in with 「记住登录状态」. */
export const REMEMBERED_ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The per-admin index outlives the longest session it can list, whichever
 * kind slid it last: an eight-hour session sliding the index to 32 h must not
 * let it expire under an idle remembered one, which would then survive a
 * password change.
 */
const INDEX_TTL_MS = REMEMBERED_ADMIN_SESSION_TTL_MS * 4;

export interface AdminSessionStore {
  create(session: Omit<AdminSession, 'createdAt'>, nowMs: number): Promise<string>;
  /**
   * Returns the session and slides its TTL forward, or `null`. `ttlMs` is the
   * idle lifetime it was slid to, for the cookie that has to follow it.
   */
  resolve(token: string): Promise<(AdminSession & { sessionId: string; ttlMs: number }) | null>;
  /**
   * Reads the session **without** sliding it. For a long-lived connection that
   * re-checks its session (the bell's SSE stream): an open tab must not keep an
   * idle admin signed in for ever.
   */
  peek(token: string): Promise<AdminSession | null>;
  destroy(token: string): Promise<void>;
  /** Password change, account disable, "log out everywhere". */
  revokeAllForAdmin(adminId: number): Promise<number>;
  countFor(adminId: number): Promise<number>;
}

/**
 * Slides the session key and, only if it still exists (a concurrent revoke may
 * just have deleted it), re-lists it in the per-admin index and slides that
 * too. Re-adding heals a session whose index expired before this was fixed.
 */
const SLIDE_LUA = `
if redis.call('PEXPIRE', KEYS[1], ARGV[2]) == 1 then
  redis.call('SADD', KEYS[2], ARGV[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  return 1
end
return 0
`;

export function createAdminSessionStore(options: AdminSessionStoreOptions): AdminSessionStore {
  const { redis, ttlMs = DEFAULT_ADMIN_SESSION_TTL_MS, keyPrefix = 'admin:sess:' } = options;
  const sessionKey = (token: string) => `${keyPrefix}${sha256Hex(token)}`;
  const indexKey = (adminId: number) => `${keyPrefix}index:${adminId}`;
  const ttlOf = (session: Pick<AdminSession, 'remember'>) =>
    session.remember === true ? REMEMBERED_ADMIN_SESSION_TTL_MS : ttlMs;

  return {
    async create(session, nowMs) {
      const token = randomToken(40);
      const hashed = sha256Hex(token);
      const value: AdminSession = { ...session, createdAt: nowMs };
      await redis
        .multi()
        .set(`${keyPrefix}${hashed}`, JSON.stringify(value), 'PX', ttlOf(session))
        .sadd(indexKey(session.adminId), hashed)
        // The index must outlive the longest possible sliding session.
        .pexpire(indexKey(session.adminId), Math.max(INDEX_TTL_MS, ttlMs * 4))
        .exec();
      return token;
    },

    async resolve(token) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
      const key = sessionKey(token);
      const raw = await redis.get(key);
      if (raw === null) return null;
      let session: AdminSession;
      try {
        session = JSON.parse(raw) as AdminSession;
      } catch {
        await redis.del(key);
        return null;
      }
      // Sliding expiry: an admin who keeps working never gets logged out — and
      // the index slides with the session, so a revoke always reaches it.
      const lifetime = ttlOf(session);
      await redis.eval(
        SLIDE_LUA,
        2,
        key,
        indexKey(session.adminId),
        sha256Hex(token),
        String(lifetime),
        String(Math.max(INDEX_TTL_MS, ttlMs * 4)),
      );
      return { ...session, sessionId: sha256Hex(token).slice(0, 16), ttlMs: lifetime };
    },

    async peek(token) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
      const raw = await redis.get(sessionKey(token));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as AdminSession;
      } catch {
        return null;
      }
    },

    async destroy(token) {
      const hashed = sha256Hex(token);
      const raw = await redis.get(`${keyPrefix}${hashed}`);
      await redis.del(`${keyPrefix}${hashed}`);
      if (raw !== null) {
        try {
          const session = JSON.parse(raw) as AdminSession;
          await redis.srem(indexKey(session.adminId), hashed);
        } catch {
          // Nothing to clean up; the session key is already gone.
        }
      }
    },

    async revokeAllForAdmin(adminId) {
      const index = indexKey(adminId);
      const hashes = await redis.smembers(index);
      if (hashes.length > 0) {
        await redis.del(...hashes.map((h) => `${keyPrefix}${h}`));
      }
      await redis.del(index);
      return hashes.length;
    },

    async countFor(adminId) {
      return redis.scard(indexKey(adminId));
    },
  };
}
