import type { CSSProperties } from 'react';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/**
 * Numbers in design px travel to the stylesheet as unitless custom properties;
 * the stylesheet multiplies them by `1px` (`calc(var(--sb-height) * 1px)`), so
 * whichever px transform the target runs — rpx in the mini-program, rem in Taro
 * H5, vw in the admin canvas — scales them with everything else. An inline
 * `height: 340px` would not be transformed on any of them.
 */
export function designVars(vars: Record<string, number>): CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) style[`--sb-${name}`] = String(value);
  return style as CSSProperties;
}

/**
 * `#rrggbbaa` → `rgba(…)`. Native component attributes (a swiper's indicator
 * colours) do not take 8-digit hex on every WeChat base library; rgba works on
 * all of them.
 */
export function cssColor(hex: string): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!match?.[1]) return hex;
  let digits = match[1];
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  if (digits.length === 6) return `#${digits}`;
  const [r, g, b, a] = [0, 2, 4, 6].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
    number,
  ];
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}

/**
 * `{ onClick }` when there is a handler, `{}` when there is not. Taro's
 * component props declare `onClick?: (event) => void` without `| undefined`,
 * so under `exactOptionalPropertyTypes` an explicit `undefined` does not
 * compile; spread this instead.
 */
export function tapProps(handler: (() => void) | undefined): { onClick?: () => void } {
  return handler ? { onClick: handler } : {};
}
