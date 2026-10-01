import { describe, expect, it } from 'vitest';
import { fixedClock } from '../kernel/clock';
import { DomainError } from '../kernel/errors';
import {
  MAX_RANGE_DAYS,
  bucketFor,
  bucketStartOf,
  rangeKey,
  resolveRange,
  shanghaiDayLabel,
  shanghaiDayStart,
  statsExportFilename,
  yearAgoRange,
} from './stats.range';

/**
 * The window arithmetic, without a database.
 *
 * Everything that can make two statistics pages disagree lives here: which day
 * an instant belongs to, which day the range includes, how long a bucket is,
 * and what "the window before this one" means.
 */

const clock = fixedClock('2026-02-04T02:00:00+08:00');

describe('shanghai days', () => {
  it('puts 23:30 and 00:30 Shanghai on different days although they share a UTC day', () => {
    // 2026-02-02T15:30Z is 23:30 on the 2nd in Shanghai; 2026-02-02T16:30Z is
    // 00:30 on the 3rd. A UTC-bucketed report calls both "the 2nd".
    const before = new Date('2026-02-02T15:30:00Z');
    const after = new Date('2026-02-02T16:30:00Z');
    expect(shanghaiDayLabel(before)).toBe('2026-02-02');
    expect(shanghaiDayLabel(after)).toBe('2026-02-03');
    expect(shanghaiDayStart(after).toISOString()).toBe('2026-02-02T16:00:00.000Z');
  });

  it('snaps to the start of the bucket it is asked for', () => {
    const at = new Date('2026-02-03T09:41:00+08:00');
    expect(bucketStartOf(at, 'hour').toISOString()).toBe('2026-02-03T01:00:00.000Z');
    expect(bucketStartOf(at, 'day').toISOString()).toBe('2026-02-02T16:00:00.000Z');
    expect(bucketStartOf(at, 'month').toISOString()).toBe('2026-01-31T16:00:00.000Z');
  });
});

describe('statsExportFilename', () => {
  it('names an export in Chinese by the Shanghai days it covers, like the order export', () => {
    const range = {
      from: new Date('2026-02-01T00:00:00+08:00'),
      to: new Date('2026-02-04T00:00:00+08:00'),
    };
    expect(statsExportFilename('交易统计', range)).toBe('交易统计-2026-02-01至2026-02-03.csv');
    const oneDay = {
      from: new Date('2026-02-03T00:00:00+08:00'),
      to: new Date('2026-02-04T00:00:00+08:00'),
    };
    expect(statsExportFilename('商品统计', oneDay)).toBe('商品统计-2026-02-03.csv');
  });
});

describe('resolveRange', () => {
  it('includes the Shanghai day the caller asked to see', () => {
    const range = resolveRange(
      { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      clock,
    );
    expect(range.from.toISOString()).toBe('2026-01-31T16:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-02-03T16:00:00.000Z');
    expect(range.bucket).toBe('day');
    expect(range.buckets).toEqual(['2026-02-01', '2026-02-02', '2026-02-03']);
  });

  it('defaults to the last 30 Shanghai days, today included', () => {
    const range = resolveRange({}, clock);
    expect(range.buckets).toHaveLength(30);
    expect(range.buckets.at(0)).toBe('2026-01-06');
    expect(range.buckets.at(-1)).toBe('2026-02-04');
  });

  it('derives the bucket from the length instead of taking it from the caller', () => {
    expect(bucketFor(1)).toBe('hour');
    expect(bucketFor(2)).toBe('hour');
    expect(bucketFor(3)).toBe('day');
    expect(bucketFor(92)).toBe('day');
    expect(bucketFor(93)).toBe('month');
  });

  it('labels a one-day window by the hour and a two-day window by day and hour', () => {
    const oneDay = resolveRange(
      { from: '2026-02-03T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      clock,
    );
    expect(oneDay.bucket).toBe('hour');
    expect(oneDay.buckets).toHaveLength(24);
    expect(oneDay.buckets.at(0)).toBe('00');
    expect(oneDay.buckets.at(-1)).toBe('23');

    const twoDays = resolveRange(
      { from: '2026-02-02T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      clock,
    );
    expect(twoDays.buckets).toHaveLength(48);
    expect(twoDays.buckets.at(0)).toBe('02-02 00');
    expect(twoDays.buckets.at(-1)).toBe('02-03 23');
  });

  it('cuts a long window into calendar months, partial ones included', () => {
    const range = resolveRange(
      { from: '2026-01-20T00:00:00+08:00', to: '2026-06-05T00:00:00+08:00' },
      clock,
    );
    expect(range.bucket).toBe('month');
    expect(range.buckets).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  it('compares against the window of the same length immediately before', () => {
    const range = resolveRange(
      { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      clock,
    );
    expect(range.previous.to).toEqual(range.from);
    expect(shanghaiDayLabel(range.previous.from)).toBe('2026-01-29');
  });

  it('refuses an inverted window and one longer than three years', () => {
    expect(() =>
      resolveRange({ from: '2026-02-05T00:00:00+08:00', to: '2026-02-01T00:00:00+08:00' }, clock),
    ).toThrow(DomainError);

    const tooLong = () =>
      resolveRange({ from: '2020-01-01T00:00:00+08:00', to: '2026-02-01T00:00:00+08:00' }, clock);
    expect(tooLong).toThrow(DomainError);
    try {
      tooLong();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'STATS_RANGE_INVALID',
        details: { maxDays: MAX_RANGE_DAYS },
      });
    }
  });

  it('accepts a window of exactly the maximum length', () => {
    const range = resolveRange(
      { from: '2023-02-04T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      clock,
    );
    expect(range.bucket).toBe('month');
    expect(range.buckets.at(0)).toBe('2023-02');
  });

  it('keys a cache entry by the two Shanghai days', () => {
    const range = resolveRange(
      { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      clock,
    );
    expect(rangeKey(range)).toBe('20260201..20260204');
  });
});

describe('yearAgoRange', () => {
  /** Shanghai days `[first, last]` of a window, for reading the assertions. */
  const days = (range: { from: Date; to: Date }) => [
    shanghaiDayLabel(range.from),
    shanghaiDayLabel(new Date(range.to.getTime() - 1)),
  ];
  const window = (first: string, last: string) => {
    const from = new Date(`${first}T00:00:00+08:00`);
    const to = new Date(new Date(`${last}T00:00:00+08:00`).getTime() + 24 * 3600 * 1000);
    return { from, to };
  };

  it('moves both ends back one Shanghai calendar year', () => {
    const range = yearAgoRange(window('2026-02-01', '2026-02-03'));
    expect(days(range)).toEqual(['2025-02-01', '2025-02-03']);
    expect(range.from.toISOString()).toBe('2025-01-31T16:00:00.000Z');
  });

  it('keeps a window crossing new year whole', () => {
    expect(days(yearAgoRange(window('2026-12-25', '2027-01-05')))).toEqual([
      '2025-12-25',
      '2026-01-05',
    ]);
  });

  it('turns 29 February into the 28th at either end', () => {
    expect(days(yearAgoRange(window('2028-02-29', '2028-03-02')))).toEqual([
      '2027-02-28',
      '2027-03-02',
    ]);
    expect(days(yearAgoRange(window('2028-02-01', '2028-02-29')))).toEqual([
      '2027-02-01',
      '2027-02-28',
    ]);
  });

  it('ends a window on 28 February on the 28th, not the 27th', () => {
    expect(days(yearAgoRange(window('2028-02-01', '2028-02-28')))).toEqual([
      '2027-02-01',
      '2027-02-28',
    ]);
  });
});
