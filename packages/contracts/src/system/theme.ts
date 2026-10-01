import type { AppAppearance, RadiusScale } from './app.schemas';

/**
 * The shop's theme, derived — one implementation for the mini-program and the admin preview
 * (docs/mini/design.md §3.3).
 *
 * **Zod-free at runtime** (types only from `app.schemas`), so the mini-program may import it;
 * `theme.test.ts` checks that no runtime import creeps in. Moved here from
 * `apps/mini/src/theme/{color,derive}.ts` unchanged in behaviour, plus `themeInputOf`.
 *
 * Colour arithmetic: WCAG 2.x contrast and HSL lightness, on `#RRGGBB`.
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#RGB` or `#RRGGBB` (the `#` optional), or `null` when it is not a hex colour. */
export function parseHex(value: string): Rgb | null {
  const match = HEX.exec(value.trim());
  if (!match) return null;
  let hex = match[1] ?? '';
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `a` laid over `b` at `alpha` (0–1). */
export function mix(a: Rgb, b: Rgb, alpha: number): Rgb {
  return {
    r: a.r * alpha + b.r * (1 - alpha),
    g: a.g * alpha + b.g * (1 - alpha),
    b: a.b * alpha + b.b * (1 - alpha),
  };
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function toHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

export function fromHsl({ h, s, l }: Hsl): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue(p, q, h + 1 / 3) * 255,
    g: hue(p, q, h) * 255,
    b: hue(p, q, h - 1 / 3) * 255,
  };
}

/**
 * The operator-editable theme turned into readable tokens (docs/mini/design.md §3.3).
 *
 * The operator's brand colour is a business decision and is kept as it is; what is derived
 * guarantees the *text* stays readable:
 *
 * 1. `onPrimary`: white or `#1A1A1A`, whichever contrasts more with the primary colour.
 * 2. `primaryText`: the primary colour if it reaches 4.5:1 on white, otherwise darkened in HSL
 *    until it does (blue `#1DB0FC` becomes about `#0077B3`).
 * 3. `price`: the operator's price colour, or `primaryText`, through the same rule as 2.
 * 4. `onAccent`: as 1, for the accent colour (the primary colour when there is no accent).
 */
export interface ThemeInput {
  primary: string;
  accent?: string | null | undefined;
  price?: string | null | undefined;
}

export interface DerivedTheme {
  primary: string;
  onPrimary: string;
  primarySoft: string;
  primaryText: string;
  accent: string;
  onAccent: string;
  price: string;
}

export const DEFAULT_PRIMARY = '#E1251B';
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const INK: Rgb = { r: 0x1a, g: 0x1a, b: 0x1a };
const INK_HEX = '#1A1A1A';
/** WCAG AA for body text. */
export const TEXT_CONTRAST = 4.5;

function onColor(background: Rgb): string {
  return contrast(background, WHITE) >= contrast(background, INK) ? '#FFFFFF' : INK_HEX;
}

/** `color`, darkened in HSL lightness until it reads at 4.5:1 on white. */
export function readableOnWhite(color: Rgb): Rgb {
  if (contrast(color, WHITE) >= TEXT_CONTRAST) return color;
  const hsl = toHsl(color);
  for (let l = hsl.l; l >= 0; l -= 0.005) {
    const candidate = fromHsl({ ...hsl, l });
    // Round first: the hex that ships must pass, not the float before it.
    const shipped = parseHex(toHex(candidate)) ?? candidate;
    if (contrast(shipped, WHITE) >= TEXT_CONTRAST) return shipped;
  }
  return INK;
}

export function deriveTheme(input: ThemeInput): DerivedTheme {
  const primary = parseHex(input.primary) ?? (parseHex(DEFAULT_PRIMARY) as Rgb);
  const accent = (input.accent ? parseHex(input.accent) : null) ?? primary;
  const primaryText = readableOnWhite(primary);
  const priceBase = input.price ? parseHex(input.price) : null;
  const price = priceBase ? readableOnWhite(priceBase) : primaryText;
  return {
    primary: toHex(primary),
    onPrimary: onColor(primary),
    primarySoft: toHex(mix(primary, WHITE, 0.1)),
    primaryText: toHex(primaryText),
    accent: toHex(accent),
    onAccent: onColor(accent),
    price: toHex(price),
  };
}

/**
 * `app/config` `appearance.theme` → `deriveTheme`'s input. A `null` accent is "none set",
 * which `deriveTheme` reads as the primary colour.
 */
export function themeInputOf(theme: AppAppearance['theme']): ThemeInput {
  return { primary: theme.primaryColor, accent: theme.accentColor, price: theme.priceColor };
}

/** `app/config` appearance.theme.radius → the multiplier on card and picture radii. */
export const RADIUS_FACTOR: Record<RadiusScale, number> = {
  none: 0,
  small: 0.5,
  medium: 1,
  large: 1.5,
};

/**
 * The CSS custom properties for a theme, as a `style` string (page-meta `page-style` takes a
 * string). Only what the operator can change is written; everything else keeps the default
 * from `app.scss`.
 */
export function themeStyle(theme: DerivedTheme, radius: RadiusScale = 'medium'): string {
  const vars: Array<[string, string]> = [
    ['--color-primary', theme.primary],
    ['--color-on-primary', theme.onPrimary],
    ['--color-primary-soft', theme.primarySoft],
    ['--color-primary-text', theme.primaryText],
    ['--color-accent', theme.accent],
    ['--color-on-accent', theme.onAccent],
    ['--color-price', theme.price],
    ['--radius-factor', String(RADIUS_FACTOR[radius])],
  ];
  return vars.map(([name, value]) => `${name}:${value}`).join(';');
}
