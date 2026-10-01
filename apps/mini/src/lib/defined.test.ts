import { describe, expect, it } from 'vitest';
import { defined, fromPairs } from './defined';

describe('fromPairs', () => {
  it('builds the record Object.fromEntries would (which iOS 12.0/12.1 lack)', () => {
    expect(
      fromPairs([
        ['a', 1],
        ['b', 2],
      ]),
    ).toEqual({ a: 1, b: 2 });
    expect(fromPairs(new Map([['k', 'v']]))).toEqual({ k: 'v' });
    expect(fromPairs([])).toEqual({});
  });
});

describe('defined', () => {
  it('drops undefined entries', () => {
    expect(defined({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});
