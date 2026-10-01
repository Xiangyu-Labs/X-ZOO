import type { LinkTarget } from '@shop/contracts/decor/link';

/**
 * 开屏浮层 (pages.md §2.1, 首页): `app/config.splashAd`, at most once a day. Its `link` is a DIY
 * `LinkTarget` (H3), opened like any block's link.
 */

/** Storage key of the shop day the overlay last showed. */
export const SPLASH_DAY_KEY = 'shop.splash.day';

const SHOP_OFFSET_MS = 8 * 60 * 60 * 1000;

/** `2026-09-24`: the day in China (UTC+8), whatever the phone's zone. */
export function shopDay(nowMs: number): string {
  return new Date(nowMs + SHOP_OFFSET_MS).toISOString().slice(0, 10);
}

export interface SplashAd {
  enabled: boolean;
  imageUrl: string | null;
  link: LinkTarget | null;
  seconds: number;
}

/** Whether the overlay should show now: switched on, has a picture, not yet shown today. */
export function splashDue(ad: SplashAd | null | undefined, lastDay: string | null, today: string) {
  return Boolean(ad?.enabled && ad.imageUrl && lastDay !== today);
}
