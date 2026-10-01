import { randomBytes, randomInt } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Verification codes in Redis, consumed **atomically**.
 *
 * A code stored under the phone alone and merely compared invites three
 * exploits:
 *
 *  1. a key that is not deleted on use lets one code work for its whole TTL — a
 *     code overheard once is a login for the next minute;
 *  2. without an attempt counter, six digits can be walked through at whatever
 *     rate the network allows;
 *  3. one key for every purpose lets a code sent to confirm a phone change also
 *     log you in.
 *
 * So the scene is part of the key, the compare-and-delete is one Lua script (a
 * `GETDEL` with a counter), and a wrong guess is counted inside the same atomic
 * step. Two concurrent verifications of the same correct code therefore produce
 * exactly one `ok`.
 */

export type VerifyOutcome = 'ok' | 'invalid' | 'attempts-exceeded';

export const CODE_LENGTH = 6;

/** `sms:code:<scene>:<phone>`. The scene is in the key, not in the value. */
export function codeKey(scene: string, phone: string): string {
  return `sms:code:${scene}:${phone}`;
}

/** The resend guard. Separate key, because it must outlive a consumed code. */
export function resendKey(scene: string, phone: string): string {
  return `sms:resend:${scene}:${phone}`;
}

/**
 * Six digits from a CSPRNG, uniform over `000000`–`999999`.
 *
 * `randomInt` rather than `Math.random()`: a predictable code is a login. And
 * the range starts at zero — `100000`–`999999` would throw away every code
 * starting with a zero, costing a tenth of the space for nothing.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
}

/**
 * Compare, consume and count, in one round trip.
 *
 *  - right code  → the key is destroyed and nobody else can use it;
 *  - wrong code  → `attempts` goes up, and the key is destroyed once the budget
 *                  is spent, so brute force costs a new SMS every `max` tries;
 *  - no key      → `invalid`, which is also what an expired or already-spent
 *                  code looks like. The caller cannot tell them apart and
 *                  neither can an attacker.
 */
const CONSUME_LUA = `
local key = KEYS[1]
local supplied = ARGV[1]
local maxAttempts = tonumber(ARGV[2])
local stored = redis.call('HGET', key, 'code')
if not stored then return 'invalid' end
if stored == supplied then
  redis.call('DEL', key)
  return 'ok'
end
local attempts = redis.call('HINCRBY', key, 'attempts', 1)
if attempts >= maxAttempts then
  redis.call('DEL', key)
  return 'attempts-exceeded'
end
return 'invalid'
`;

export interface IssueInput {
  scene: string;
  phone: string;
  code: string;
  ttlMs: number;
}

/**
 * Stores the code. The resend guard is **not** written here: `claimResend`
 * wrote it, atomically, before anything else happened.
 */
export async function issueCode(redis: Redis, input: IssueInput): Promise<void> {
  const key = codeKey(input.scene, input.phone);
  await redis
    .multi()
    .del(key)
    .hset(key, 'code', input.code, 'attempts', '0')
    .pexpire(key, input.ttlMs)
    .exec();
}

/** Undo an issue whose SMS the provider then refused. */
export async function discardCode(redis: Redis, scene: string, phone: string): Promise<void> {
  await redis.del(codeKey(scene, phone));
}

/**
 * The resend guard **is** the write: `SET key token NX PX`.
 *
 * A `PTTL` check followed, a few round trips later, by a plain `SET … PX` would
 * let every tap that read before the first write landed get through, mint a
 * code over the previous one and cost an SMS, up to the per-phone hourly
 * budget: five messages for one double-tap, and only the last code valid. As
 * one write, exactly one caller per window wins the key.
 *
 * Returns `{ waitMs: 0, token }` to the caller that claimed the window, or
 * the milliseconds left to everybody else. The token lets the claimant hand
 * the window back (`releaseResend`) without deleting a later caller's claim.
 */
export async function claimResend(
  redis: Redis,
  scene: string,
  phone: string,
  resendMs: number,
): Promise<{ waitMs: 0; token: string } | { waitMs: number; token: null }> {
  const token = randomBytes(9).toString('base64url');
  const claimed = await redis.set(resendKey(scene, phone), token, 'PX', resendMs, 'NX');
  if (claimed === 'OK') return { waitMs: 0, token };
  const ttl = await redis.pttl(resendKey(scene, phone));
  // `-1`/`-2` here means the key lost its TTL or vanished between the two
  // calls; either way this caller did not claim it, so it waits a moment.
  return { waitMs: ttl > 0 ? ttl : 1, token: null };
}

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * Hands a claimed window back, so a refusal (a budget, the provider) does not
 * make the shopper wait out a window in which nothing was sent. Only the
 * claimant's own token is deleted.
 */
export async function releaseResend(
  redis: Redis,
  scene: string,
  phone: string,
  token: string,
): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, resendKey(scene, phone), token);
}

export async function consumeCode(
  redis: Redis,
  input: { scene: string; phone: string; code: string; maxAttempts: number },
): Promise<VerifyOutcome> {
  const outcome = await redis.eval(
    CONSUME_LUA,
    1,
    codeKey(input.scene, input.phone),
    input.code,
    String(input.maxAttempts),
  );
  return outcome === 'ok' || outcome === 'attempts-exceeded' ? outcome : 'invalid';
}

/** Milliseconds until this phone may ask for another code in this scene; 0 when it may now. */
export async function resendWaitMs(redis: Redis, scene: string, phone: string): Promise<number> {
  const ttl = await redis.pttl(resendKey(scene, phone));
  return ttl > 0 ? ttl : 0;
}
