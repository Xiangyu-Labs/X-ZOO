import { describe, expect, it } from 'vitest';

import { dayjs, isEndOfWindow, pickerToInstant } from './instant';

describe('pickerToInstant', () => {
  it('reads the picked day as a Shanghai day, whatever zone the browser is in', () => {
    // What antd hands back for 9 月 30 日 on a laptop set to UTC.
    const pickedInUtc = dayjs.utc('2026-09-30T00:00:00');
    expect(pickerToInstant(pickedInUtc)).toBe('2026-09-30T00:00:00+08:00');
    // …and on one set to New York.
    const pickedInNewYork = dayjs('2026-09-30T00:00:00-04:00').utcOffset(-240);
    expect(pickerToInstant(pickedInNewYork)).toBe('2026-09-30T00:00:00+08:00');
  });

  it('snaps an end date to the last second of its day', () => {
    const picked = dayjs.utc('2026-09-30T00:00:00');
    expect(pickerToInstant(picked, 'endOfDay')).toBe('2026-09-30T23:59:59+08:00');
    expect(pickerToInstant(picked, 'startOfDay')).toBe('2026-09-30T00:00:00+08:00');
  });

  it('keeps a picked time as the operator saw it', () => {
    expect(pickerToInstant(dayjs.utc('2026-09-30T18:30:00'))).toBe('2026-09-30T18:30:00+08:00');
    expect(pickerToInstant(null)).toBeUndefined();
  });
});

describe('isEndOfWindow', () => {
  it('knows the end of a window by its name', () => {
    for (const name of ['endAt', 'validTo', 'claimTo', 'createdTo', 'activeUntil', 'expireAt']) {
      expect(isEndOfWindow(name)).toBe(true);
    }
    for (const name of [
      'startAt',
      'validFrom',
      'claimFrom',
      'birthday',
      'createdAt',
      'publishedAt',
    ]) {
      expect(isEndOfWindow(name)).toBe(false);
    }
    expect(isEndOfWindow(['window', 'endAt'])).toBe(true);
  });
});
