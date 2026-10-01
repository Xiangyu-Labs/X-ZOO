import type Redis from 'ioredis';
import { randomToken } from '../kernel/ids';

/**
 * Scan-to-upload tokens.
 *
 * **One** token in a cache entry under a fixed key would belong to whoever
 * opened the dialog last: a phone that scanned an older QR code would upload
 * into the newest admin's session, and the token would stay valid until it
 * expired no matter how many files went through it.
 *
 * Here a token is:
 *
 *  - **minted per admin**, carrying the admin id and the destination folder, so
 *    the resulting attachment is attributed and filed correctly;
 *  - **single-use**, and that is enforced by an atomic compare-and-set in Redis,
 *    not by a read followed by a write. Two phones scanning the same code race
 *    on one `HGET`/`HSET` inside one script: exactly one wins;
 *  - **short-lived** (`storage.scanTokenTtlSeconds`, 10 minutes by default).
 *
 * The record outlives its claim by a couple of minutes so the admin's polling
 * `GET …/scan-tokens/:token` can report `used` and hand back the attachment.
 */

export type ScanTokenState = 'pending' | 'claimed' | 'used';

export interface ScanTokenRecord {
  adminId: number;
  categoryId: number | null;
  directory: string | null;
  state: ScanTokenState;
  attachmentId: number | null;
}

export interface ScanTokenStore {
  create(input: {
    adminId: number;
    categoryId?: number | null;
    directory?: string | null;
    ttlMs: number;
  }): Promise<{ token: string; expiresAt: Date }>;
  /** Atomically moves `pending` → `claimed`. `null` means expired or spent. */
  claim(token: string): Promise<ScanTokenRecord | null>;
  /**
   * Records the attachment against a **claimed** token and marks it `used`.
   * `false` when the token is not claimed (pending, used, gone): nothing is
   * written.
   */
  complete(token: string, attachmentId: number): Promise<boolean>;
  /** Puts a claimed token back, so a failed store does not burn the QR code. */
  release(token: string): Promise<void>;
  read(token: string): Promise<ScanTokenRecord | null>;
}

const PREFIX = 'storage:scan:';

/** How long a spent token's record lingers so the admin's poll can see it. */
const USED_LINGER_MS = 120_000;

/**
 * GET the state and, only if it is still `pending`, write `claimed` — in one
 * round trip, so there is no window between the two for a second phone.
 * Returns `{state, adminId, categoryId, directory}` or an empty reply.
 */
const CLAIM_LUA = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == false then return {} end
if state ~= 'pending' then return {} end
redis.call('HSET', KEYS[1], 'state', 'claimed')
return redis.call('HMGET', KEYS[1], 'adminId', 'categoryId', 'directory')
`;

/**
 * Marks a claimed token used and keeps the record readable for a short while. A
 * compare-and-set on `state`, like its two siblings: an existence check would
 * stamp `used` over a `pending` record.
 */
const COMPLETE_LUA = `
if redis.call('HGET', KEYS[1], 'state') ~= 'claimed' then return 0 end
redis.call('HSET', KEYS[1], 'state', 'used', 'attachmentId', ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

const RELEASE_LUA = `
if redis.call('HGET', KEYS[1], 'state') ~= 'claimed' then return 0 end
redis.call('HSET', KEYS[1], 'state', 'pending')
return 1
`;

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

export function createScanTokenStore(redis: Redis, now: () => Date): ScanTokenStore {
  const key = (token: string) => `${PREFIX}${token}`;

  return {
    async create({ adminId, categoryId = null, directory = null, ttlMs }) {
      // 24 characters of `randomToken`'s 32-symbol alphabet: 120 bits, inside
      // the contract's `[A-Za-z0-9_-]{16,64}`, and far past guessing range for
      // something that lives ten minutes.
      const token = randomToken(24);
      await redis
        .multi()
        .hset(key(token), {
          adminId: String(adminId),
          categoryId: categoryId === null ? '' : String(categoryId),
          directory: directory ?? '',
          state: 'pending',
          attachmentId: '',
        })
        .pexpire(key(token), ttlMs)
        .exec();
      return { token, expiresAt: new Date(now().getTime() + ttlMs) };
    },

    async claim(token) {
      const raw = (await redis.eval(CLAIM_LUA, 1, key(token))) as string[] | null;
      if (!raw || raw.length === 0) return null;
      const adminId = numberOrNull(raw[0]);
      if (adminId === null) return null;
      return {
        adminId,
        categoryId: numberOrNull(raw[1]),
        directory: stringOrNull(raw[2]),
        state: 'claimed',
        attachmentId: null,
      };
    },

    async complete(token, attachmentId) {
      const done = await redis.eval(
        COMPLETE_LUA,
        1,
        key(token),
        String(attachmentId),
        String(USED_LINGER_MS),
      );
      return done === 1;
    },

    async release(token) {
      await redis.eval(RELEASE_LUA, 1, key(token));
    },

    async read(token) {
      const raw = await redis.hgetall(key(token));
      if (!raw || Object.keys(raw).length === 0) return null;
      const adminId = numberOrNull(raw['adminId']);
      if (adminId === null) return null;
      const state = raw['state'];
      return {
        adminId,
        categoryId: numberOrNull(raw['categoryId']),
        directory: stringOrNull(raw['directory']),
        state: state === 'used' || state === 'claimed' ? state : 'pending',
        attachmentId: numberOrNull(raw['attachmentId']),
      };
    },
  };
}
