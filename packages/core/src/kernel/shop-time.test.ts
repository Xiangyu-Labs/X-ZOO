import { describe, expect, it } from 'vitest';
import { shopDateTime, shopDay, shopDayStart } from './shop-time';

describe('the shop’s clock for exports', () => {
  it('prints Shanghai wall time, not UTC', () => {
    expect(shopDateTime(new Date('2026-02-03T16:30:05.999Z'))).toBe('2026-02-04 00:30:05');
    expect(shopDateTime(new Date('2026-02-03T01:02:03Z'))).toBe('2026-02-03 09:02:03');
  });

  it('opens a day at Shanghai midnight', () => {
    expect(shopDayStart(new Date('2026-02-03T16:30:00Z')).toISOString()).toBe(
      '2026-02-03T16:00:00.000Z',
    );
    expect(shopDayStart(new Date('2026-02-03T15:59:59Z')).toISOString()).toBe(
      '2026-02-02T16:00:00.000Z',
    );
    expect(shopDayStart(new Date('2026-02-03T16:00:00Z')).toISOString()).toBe(
      '2026-02-03T16:00:00.000Z',
    );
  });

  it('dates a file on the Shanghai day', () => {
    expect(shopDay(new Date('2026-02-03T16:00:00Z'))).toBe('2026-02-04');
    expect(shopDay(new Date('2026-02-03T15:59:59Z'))).toBe('2026-02-03');
  });
});
