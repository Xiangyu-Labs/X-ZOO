import { describe, expect, it } from 'vitest';
import { unitAmount } from './schemas';

describe('a 运费模板 measurement', () => {
  it('accepts two decimals that binary floating point cannot hold exactly', () => {
    for (const value of [0, 1, 1.1, 2.3, 0.29, 0.07, 19.99, 1234.56]) {
      expect(unitAmount.safeParse(value).success, String(value)).toBe(true);
    }
  });

  it('refuses a third decimal and a negative', () => {
    for (const value of [1.005, 0.001, 2.345, -1]) {
      expect(unitAmount.safeParse(value).success, String(value)).toBe(false);
    }
  });
});
