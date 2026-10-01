/**
 * Dates and phone numbers as the shop shows them. Instants arrive as ISO strings with an
 * offset; the shop is in China, so they are shown in UTC+8 whatever the phone's zone.
 */

const SHOP_OFFSET_MS = 8 * 60 * 60 * 1000;

function parts(
  instant: string,
): { y: string; m: string; d: string; hh: string; mm: string } | null {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  const shifted = new Date(ms + SHOP_OFFSET_MS);
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    y: String(shifted.getUTCFullYear()),
    m: two(shifted.getUTCMonth() + 1),
    d: two(shifted.getUTCDate()),
    hh: two(shifted.getUTCHours()),
    mm: two(shifted.getUTCMinutes()),
  };
}

/** `2026.09.23` */
export function formatDate(instant: string): string {
  const p = parts(instant);
  return p ? `${p.y}.${p.m}.${p.d}` : '';
}

/** `2026.09.23 14:05` */
export function formatDateTime(instant: string): string {
  const p = parts(instant);
  return p ? `${p.y}.${p.m}.${p.d} ${p.hh}:${p.mm}` : '';
}

/** `138****8000`: the middle four hidden (design.md §4.4 AddressCard). */
export function maskPhone(phone: string): string {
  const digits = phone.trim();
  return /^\d{11}$/.test(digits) ? `${digits.slice(0, 3)}****${digits.slice(7)}` : digits;
}
