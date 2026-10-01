import type { StatsBucket, StatsRangeQuery } from '@shop/contracts/stats/schemas';
import type { Clock } from '../kernel/clock';
import { DomainError } from '../kernel/errors';

/**
 * The window, the buckets, and the Shanghai day arithmetic behind both.
 *
 * Pure: a `Clock` in, a resolved range out, no database and no `ctx`. Every
 * fiddly case — the default window, the derived bucket, the boundary that is a
 * Shanghai midnight rather than a UTC one, the comparison window — is decided
 * here and unit-tested next door without Docker.
 *
 * ## Why a fixed +08:00 and not a tz database lookup
 *
 * Mainland China has observed no daylight saving since 1991 and no offset
 * change since, so `Asia/Shanghai` is +08:00 for every instant this database
 * can contain. The SQL side still says `at time zone 'Asia/Shanghai'` — it is
 * reading the same zone, from PostgreSQL's own tz data — and
 * `stats.int.test.ts` pins the agreement with a fixture that straddles a
 * Shanghai midnight. If the shop ever needs a second zone, this constant and
 * the SQL literal are the two places that change.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Asia/Shanghai, as an offset. See the note above. */
export const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

/** Three years plus a leap day. Longer windows are refused, not truncated. */
export const MAX_RANGE_DAYS = 1096;

/** The window used when the caller sends neither end. */
export const DEFAULT_RANGE_DAYS = 30;

export interface ResolvedRange {
  /** The Shanghai midnight that opens the first day of the window. */
  from: Date;
  /** The Shanghai midnight that opens the day after the last one. Exclusive. */
  to: Date;
  bucket: StatsBucket;
  /** Bucket starts, ascending, covering `[from, to)` exactly. */
  bucketStarts: Date[];
  /** Labels, same length and order as `bucketStarts`. */
  buckets: string[];
  /** The window of the same length immediately before this one. */
  previous: { from: Date; to: Date };
}

// ---------------------------------------------------------------------------
// Shanghai calendar arithmetic
// ---------------------------------------------------------------------------

/**
 * The civil fields of an instant in Shanghai. Read through the UTC getters of
 * a shifted date, which is the only way to get a fixed offset out of `Date`
 * without pulling in a formatter.
 */
function parts(at: Date): { year: number; month: number; day: number; hour: number } {
  const shifted = new Date(at.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

/** The instant of a Shanghai civil time. */
function instantOf(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month, day, hour) - SHANGHAI_OFFSET_MS);
}

/** The Shanghai midnight that opens the day containing `at`. */
export function shanghaiDayStart(at: Date): Date {
  const p = parts(at);
  return instantOf(p.year, p.month, p.day);
}

/** The Shanghai midnight that opens the month containing `at`. */
export function shanghaiMonthStart(at: Date): Date {
  const p = parts(at);
  return instantOf(p.year, p.month, 1);
}

/** The Shanghai hour boundary that opens the hour containing `at`. */
export function shanghaiHourStart(at: Date): Date {
  const p = parts(at);
  return instantOf(p.year, p.month, p.day, p.hour);
}

function addDays(at: Date, days: number): Date {
  const p = parts(at);
  return instantOf(p.year, p.month, p.day + days, p.hour);
}

function addMonths(at: Date, months: number): Date {
  const p = parts(at);
  return instantOf(p.year, p.month + months, p.day, p.hour);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-02-03`, in Shanghai. Also what the CSV exports print in their 日期 column. */
export function shanghaiDayLabel(at: Date): string {
  const p = parts(at);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

// ---------------------------------------------------------------------------
// resolving
// ---------------------------------------------------------------------------

/**
 * Turn the caller's two optional instants into a window of whole Shanghai days.
 *
 * `to` is the instant the window must *contain*, so its Shanghai day is
 * included and the exclusive end is the following midnight: the admin kit's
 * date-range filter sends `…T23:59:59+08:00` for "up to and including the
 * 3rd", and a naive `< to` would drop the last second of the day.
 */
export function resolveRange(query: StatsRangeQuery, clock: Clock): ResolvedRange {
  const now = clock.now();
  const today = shanghaiDayStart(now);

  const to =
    query.to === undefined ? addDays(today, 1) : addDays(shanghaiDayStart(new Date(query.to)), 1);
  const from =
    query.from === undefined
      ? addDays(to, -DEFAULT_RANGE_DAYS)
      : shanghaiDayStart(new Date(query.from));

  if (!(from.getTime() < to.getTime())) {
    throw new DomainError('STATS_RANGE_INVALID', { details: { maxDays: MAX_RANGE_DAYS } });
  }
  const spanDays = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new DomainError('STATS_RANGE_INVALID', { details: { maxDays: MAX_RANGE_DAYS } });
  }

  const bucket = bucketFor(spanDays);
  const bucketStarts = enumerate(from, to, bucket);

  return {
    from,
    to,
    bucket,
    bucketStarts,
    buckets: bucketStarts.map((start) => bucketLabel(start, bucket, spanDays)),
    previous: { from: new Date(from.getTime() - (to.getTime() - from.getTime())), to: from },
  };
}

/**
 * The bucket is derived from the length and never chosen by the caller, so a
 * quarter cannot be drawn as ninety-two daily points squeezed into a chart
 * that can show thirty.
 */
export function bucketFor(spanDays: number): StatsBucket {
  if (spanDays <= 2) return 'hour';
  if (spanDays <= 92) return 'day';
  return 'month';
}

function enumerate(from: Date, to: Date, bucket: StatsBucket): Date[] {
  const starts: Date[] = [];
  const end = to.getTime();
  if (bucket === 'month') {
    let cursor = shanghaiMonthStart(from);
    while (cursor.getTime() < end) {
      starts.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    return starts;
  }
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS;
  // Day steps go through the calendar rather than through milliseconds so that
  // a future offset change could not silently produce 23- or 25-hour days.
  let cursor = from;
  while (cursor.getTime() < end) {
    starts.push(cursor);
    cursor = bucket === 'hour' ? new Date(cursor.getTime() + step) : addDays(cursor, 1);
  }
  return starts;
}

/**
 * `09` for an hour inside a one-day window, `02-03 09` when the window covers
 * two days (otherwise the chart would show `00`…`23` twice and the operator
 * could not tell which day a spike was on), `2026-02-03` for a day, `2026-02`
 * for a month.
 */
export function bucketLabel(start: Date, bucket: StatsBucket, spanDays: number): string {
  const p = parts(start);
  if (bucket === 'hour') {
    return spanDays <= 1 ? pad(p.hour) : `${pad(p.month + 1)}-${pad(p.day)} ${pad(p.hour)}`;
  }
  if (bucket === 'month') return `${p.year}-${pad(p.month + 1)}`;
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/** Snap an instant to the start of the bucket it falls in. */
export function bucketStartOf(at: Date, bucket: StatsBucket): Date {
  if (bucket === 'hour') return shanghaiHourStart(at);
  if (bucket === 'month') return shanghaiMonthStart(at);
  return shanghaiDayStart(at);
}

/** The PostgreSQL `date_trunc` unit for a bucket. */
export function truncUnit(bucket: StatsBucket): 'hour' | 'day' | 'month' {
  return bucket;
}

/** The same Shanghai calendar day one year earlier; 29 February becomes the 28th. */
function sameDayYearEarlier(at: Date): Date {
  const p = parts(at);
  const lastOfMonth = new Date(Date.UTC(p.year - 1, p.month + 1, 0)).getUTCDate();
  return instantOf(p.year - 1, p.month, Math.min(p.day, lastOfMonth));
}

/**
 * 去年同期: the same Shanghai calendar days one year earlier.
 *
 * The first and the *last* day are moved, not the exclusive end, so that a
 * window ending on 28 February 2028 ends on 28 February 2027 and not on the
 * 27th (its exclusive end, 29 February, would clamp to the 28th). A window
 * containing 29 February is therefore one day shorter a year earlier, which is
 * the calendar's doing.
 */
export function yearAgoRange(range: { from: Date; to: Date }): { from: Date; to: Date } {
  return {
    from: sameDayYearEarlier(range.from),
    to: addDays(sameDayYearEarlier(addDays(range.to, -1)), 1),
  };
}

/** Stable, human-readable part of a cache key: `20260201-20260204`. */
export function rangeKey(range: { from: Date; to: Date }): string {
  return `${shanghaiDayLabel(range.from)}..${shanghaiDayLabel(range.to)}`.replaceAll('-', '');
}

/**
 * What a statistics export is saved as, named like the order and product
 * exports: `交易统计-2026-02-01至2026-02-03.csv`, one Shanghai day alone when
 * the window is a single day.
 */
export function statsExportFilename(title: string, range: { from: Date; to: Date }): string {
  const first = shanghaiDayLabel(range.from);
  const last = shanghaiDayLabel(new Date(range.to.getTime() - 1));
  return `${title}-${first === last ? first : `${first}至${last}`}.csv`;
}
