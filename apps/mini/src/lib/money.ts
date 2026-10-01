/** `"12.30"` → 1230. Money strings from the API always have at most two decimals. */
export function toCents(money: string): number {
  const [whole = '0', fraction = ''] = money.trim().split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2)));
}

/** 1230 → `"12.30"`. */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The 划线价 worth striking through next to `price`: `original` only when it is above what is
 * charged. A 划线价 at or below the price (a product edited down to its old price, an activity
 * priced at the catalogue price) is no saving and is not shown.
 */
export function strikePrice(price: string, original: string | null | undefined): string | null {
  return original && toCents(original) > toCents(price) ? original : null;
}
