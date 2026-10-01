import type Redis from 'ioredis';
import { DomainError } from './errors';

/**
 * Redis rate limiting.
 *
 * Everything reaches the app through one shared reverse proxy, so a per-IP
 * limiter would throttle the whole shop at once. Limits are therefore keyed by
 * the *subject* — an account, a phone number, a user id — and the key is
 * always built by the caller so it is obvious what is being limited.
 *
 * Two shapes:
 *  - `fixedWindow` — "5 login attempts per account per 15 minutes". Cheap,
 *    slightly bursty at a window edge, fine for abuse control.
 *  - `tokenBucket` — "1 SMS per 60s, burst of 3". Smooth, for things that cost
 *    real money per call.
 *
 * Both are single round-trips and atomic: the counting and the expiry happen
 * inside one Lua script, so two concurrent requests cannot both see "0 used".
 */

export interface RateLimitResult {
  allowed: boolean;
  /** How many more calls are allowed right now. */
  remaining: number;
  /** Epoch millis when the limit fully resets. */
  resetAt: number;
  /** Milliseconds to wait before retrying; 0 when allowed. */
  retryAfterMs: number;
}

/** INCR, set the TTL on first use, return count and TTL in one go. */
const FIXED_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export interface FixedWindowOptions {
  key: string;
  limit: number;
  windowMs: number;
  /** Injected so a test can assert `resetAt` without a real clock. */
  nowMs: number;
}

export async function fixedWindow(
  redis: Redis,
  options: FixedWindowOptions,
): Promise<RateLimitResult> {
  const { key, limit, windowMs, nowMs } = options;
  const raw = (await redis.eval(FIXED_WINDOW_LUA, 1, key, String(windowMs))) as [number, number];
  const count = Number(raw[0]);
  const ttl = Number(raw[1]);
  const resetAt = nowMs + (ttl > 0 ? ttl : windowMs);
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfterMs: allowed ? 0 : Math.max(0, resetAt - nowMs),
  };
}

/** Forgets a subject's counter — called after a *successful* login. */
export async function resetFixedWindow(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Classic token bucket held in a hash: `{ tokens, updatedAt }`, refilled
 * lazily. `capacity` is the burst, `refillPerSec` the steady rate.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  at = now
end
local elapsed = math.max(0, now - at)
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, ttl)

local waitMs = 0
if allowed == 0 then
  waitMs = math.ceil((cost - tokens) / refillPerMs)
end
return { allowed, tostring(tokens), waitMs }
`;

export interface TokenBucketOptions {
  key: string;
  /** Burst size. */
  capacity: number;
  refillPerSec: number;
  nowMs: number;
  /** Tokens this call consumes. Defaults to 1. */
  cost?: number;
}

export async function tokenBucket(
  redis: Redis,
  options: TokenBucketOptions,
): Promise<RateLimitResult> {
  const { key, capacity, refillPerSec, nowMs, cost = 1 } = options;
  if (refillPerSec <= 0) throw new RangeError('tokenBucket: refillPerSec 必须大于 0');
  const refillPerMs = refillPerSec / 1000;
  // Keep the key around long enough for the bucket to have refilled completely.
  const ttl = Math.ceil((capacity / refillPerMs) * 2) + 1000;
  const raw = (await redis.eval(
    TOKEN_BUCKET_LUA,
    1,
    key,
    String(capacity),
    String(refillPerMs),
    String(nowMs),
    String(cost),
    String(ttl),
  )) as [number, string, number];
  const allowed = Number(raw[0]) === 1;
  const tokens = Number(raw[1]);
  const waitMs = Number(raw[2]);
  return {
    allowed,
    remaining: Math.floor(tokens),
    resetAt: nowMs + Math.ceil((capacity - tokens) / refillPerMs),
    retryAfterMs: allowed ? 0 : waitMs,
  };
}

/**
 * Throws `RATE_LIMITED` (429) with a `retryAfterMs` detail when the limit is
 * exceeded, so the caller is one line:
 *
 *     await enforce(fixedWindow(redis, { key: `sms:${phone}`, limit: 5, windowMs: HOUR, nowMs }));
 */
export async function enforce(
  result: RateLimitResult | Promise<RateLimitResult>,
  code = 'RATE_LIMITED',
): Promise<RateLimitResult> {
  const resolved = await result;
  if (!resolved.allowed) {
    throw new DomainError(code, {
      details: { retryAfterMs: resolved.retryAfterMs, resetAt: resolved.resetAt },
    });
  }
  return resolved;
}
