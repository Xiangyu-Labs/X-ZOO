import type { StatsFormat } from '@shop/contracts/stats/schemas';

/**
 * How a statistics figure is written down.
 *
 * Statistics money is a rounded `number`, not the `"12.00"` string the rest of
 * the admin uses — see the long note at the top of `contracts/src/stats/
 * schemas.ts`. `@/admin/kit/money` therefore does not apply here, and must not
 * be reached for: it would throw on `82310.4`.
 */
export function formatFigure(value: number, format: StatsFormat): string {
  switch (format) {
    case 'money':
      // The sign goes outside the symbol: a refund reads "-¥145.00", not "¥-145.00".
      return `${value < 0 ? '-' : ''}¥${grouped(Math.abs(value).toFixed(2))}`;
    case 'percent':
      return `${value.toFixed(2)}%`;
    case 'count':
      return grouped(String(Math.round(value)));
    case 'duration':
      return duration(value);
  }
}

/** Seconds as 秒 / 分 / 小时, down to the second: `45秒`, `1分05秒`, `2小时03分`. */
function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}小时${pad(minutes)}分`;
  if (minutes > 0) return `${minutes}分${pad(secs)}秒`;
  return `${secs}秒`;
}

/** The same, without the ¥ / % — for a chart axis, where the unit is in the legend. */
export function formatAxis(value: number, format: StatsFormat): string {
  if (format === 'count') return grouped(String(Math.round(value)));
  if (format === 'duration') return duration(value);
  if (Math.abs(value) >= 10_000) return `${grouped((value / 10_000).toFixed(1))}万`;
  return value.toFixed(format === 'percent' ? 0 : 2);
}

/**
 * 环比: this window against the one immediately before it.
 *
 * `null` when there is nothing to compare against, and — deliberately — also
 * when the previous window was 0. "Up ∞%" is not a fact about the shop, and a
 * page that prints it teaches operators to ignore the arrow.
 */
export function deltaPercent(value: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((value - previous) / Math.abs(previous)) * 10_000) / 100;
}

function grouped(text: string): string {
  const [whole = '0', frac] = text.split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${withCommas}${frac === undefined ? '' : `.${frac}`}`;
}
