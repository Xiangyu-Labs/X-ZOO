import { describe, expect, it } from 'vitest';
import { ttlText } from './promo-rules';

describe('ttlText', () => {
  it('says days, hours or minutes', () => {
    expect(ttlText(86400)).toBe('1 天');
    expect(ttlText(2 * 86400)).toBe('2 天');
    expect(ttlText(36 * 3600)).toBe('36 小时');
    expect(ttlText(5400)).toBe('1.5 小时');
    expect(ttlText(600)).toBe('10 分钟');
  });
});
