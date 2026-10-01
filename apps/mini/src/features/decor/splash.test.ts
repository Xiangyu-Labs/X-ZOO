import { describe, expect, it } from 'vitest';
import { shopDay, splashDue } from './splash';

const ad = { enabled: true, imageUrl: '/uploads/splash.png', link: null, seconds: 3 };

describe('开屏浮层 rules', () => {
  it('counts days in China, whatever the phone’s zone', () => {
    expect(shopDay(Date.parse('2026-09-23T16:30:00Z'))).toBe('2026-09-24');
    expect(shopDay(Date.parse('2026-09-23T15:59:00Z'))).toBe('2026-09-23');
  });

  it('is due once a day, when switched on with a picture', () => {
    expect(splashDue(ad, null, '2026-09-24')).toBe(true);
    expect(splashDue(ad, '2026-09-23', '2026-09-24')).toBe(true);
    expect(splashDue(ad, '2026-09-24', '2026-09-24')).toBe(false);
    expect(splashDue({ ...ad, enabled: false }, null, '2026-09-24')).toBe(false);
    expect(splashDue({ ...ad, imageUrl: null }, null, '2026-09-24')).toBe(false);
    expect(splashDue(null, null, '2026-09-24')).toBe(false);
  });
});
