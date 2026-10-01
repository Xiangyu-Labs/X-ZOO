import { randomInt } from 'node:crypto';
import type { Clock } from './clock';

/**
 * Ids on the wire and order numbers.
 *
 * `docs/conventions.md`: "IDs are decimal strings". They are `bigint` identity
 * columns in PostgreSQL, but JSON numbers lose precision past 2^53, so every id
 * crosses the boundary as a string. `toId`/`fromId` are the only two places
 * that convert.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** DB number -> wire string. */
export function toId(value: number): string {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`toId: 主键必须是正整数，收到 ${value}`);
  }
  return String(value);
}

/** Wire string -> DB number. Throws `TypeError`; callers turn that into a 422. */
export function fromId(value: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`fromId: id 格式不正确 "${value}"`);
  }
  const n = Number(value);
  if (n > MAX_SAFE) throw new TypeError(`fromId: id 超出安全整数范围 "${value}"`);
  return n;
}

/** `null`-tolerant `toId`, for nullable foreign keys. */
export function toIdOrNull(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : toId(value);
}

// ---------------------------------------------------------------------------
// Order numbers
// ---------------------------------------------------------------------------

/**
 * Order numbers are time-prefixed and human-readable: sorting them sorts by
 * creation time, and support can read one over the phone. They are NOT a
 * snowflake — we have no worker-id allocator and do not want one.
 *
 * Layout (24 chars, digits only):
 *
 *     yyyyMMddHHmmss  local (Asia/Shanghai) creation time
 *     ccc             per-process counter, wraps at 1000
 *     rrrrrrr         7 cryptographically random digits
 *
 * Collision needs the same process, in the same second, on the same counter
 * slot, drawing the same 7 digits: 1 in 10^7 for a pair, and the `order_no`
 * UNIQUE index is still the authority. Generation is pure given a `Clock`,
 * so a test can pin the prefix.
 */

const ORDER_NO_TZ = 'Asia/Shanghai';
const COUNTER_MODULO = 1000;
const RANDOM_DIGITS = 7;

let counter = randomInt(0, COUNTER_MODULO);

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ORDER_NO_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** `2026-02-03T04:05:06Z` -> `20260203120506` in Asia/Shanghai. */
export function timePrefix(at: Date): string {
  const parts = partsFormatter.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  // `hour: '2-digit'` with hour12:false yields "24" for midnight in some ICU builds.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}${get('month')}${get('day')}${hour}${get('minute')}${get('second')}`;
}

function randomDigits(count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += String(randomInt(0, 10));
  return out;
}

export interface OrderNoOptions {
  /** Optional short business prefix, e.g. `'R'` for a refund number. Digits stay digits. */
  prefix?: string;
}

export function generateOrderNo(clock: Clock, options: OrderNoOptions = {}): string {
  counter = (counter + 1) % COUNTER_MODULO;
  const seq = String(counter).padStart(3, '0');
  return `${options.prefix ?? ''}${timePrefix(clock.now())}${seq}${randomDigits(RANDOM_DIGITS)}`;
}

/** WeChat Pay's `out_trade_no`: same shape, distinct prefix so the two never collide. */
export function generateOutTradeNo(clock: Clock): string {
  return generateOrderNo(clock, { prefix: 'P' });
}

/** Opaque, URL-safe random token. Used for session tokens and one-shot keys. */
export function randomToken(bytes = 32): string {
  // Base32-ish alphabet: no look-alike characters, safe in a URL and in a header.
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < bytes; i += 1) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}
