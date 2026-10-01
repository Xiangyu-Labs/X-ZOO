/**
 * An instant as the shop reads it: Asia/Shanghai, which has no daylight saving,
 * so a fixed +08:00 is exact. For what staff open in Excel — CSV cells and file
 * names — where an ISO string in UTC puts an 00:30 order on the previous day.
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const SHOP_DAY_MS = 24 * 60 * 60 * 1000;

function shifted(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS).toISOString();
}

/** `2026-02-03T16:30:00Z` -> `2026-02-04 00:30:00`. */
export function shopDateTime(at: Date): string {
  const text = shifted(at);
  return `${text.slice(0, 10)} ${text.slice(11, 19)}`;
}

/** The Shanghai midnight that opens the day containing `at`. */
export function shopDayStart(at: Date): Date {
  const local = at.getTime() + SHANGHAI_OFFSET_MS;
  return new Date(
    local - (((local % SHOP_DAY_MS) + SHOP_DAY_MS) % SHOP_DAY_MS) - SHANGHAI_OFFSET_MS,
  );
}

/** `2026-02-03T16:30:00Z` -> `2026-02-04`: the shop's calendar day. */
export function shopDay(at: Date): string {
  return shifted(at).slice(0, 10);
}
