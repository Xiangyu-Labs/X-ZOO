import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appAppearanceDefaults } from './app.schemas';
import { contrast, deriveTheme, parseHex, TEXT_CONTRAST, themeInputOf, themeStyle } from './theme';

const rgb = (hex: string) => {
  const value = parseHex(hex);
  if (!value) throw new Error(hex);
  return value;
};
const WHITE = rgb('#FFFFFF');

/** The old uni-app's one-tap palettes plus the new default. */
const PALETTES = ['#E93323', '#1DB0FC', '#42CA4D', '#FF448F', '#FE5C2D', '#E1251B'];

function randomHex(seed: number): string {
  // Deterministic LCG, so a failure reproduces.
  let x = seed;
  const next = () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % 256;
  };
  return `#${[next(), next(), next()].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

describe('SYS-021 — deriveTheme keeps text readable', () => {
  it.each(PALETTES)('%s: text on white reaches 4.5:1, text on the colour 3:1', (primary) => {
    const theme = deriveTheme({ primary });
    expect(contrast(rgb(theme.primaryText), WHITE)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(rgb(theme.price), WHITE)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(rgb(theme.primary), rgb(theme.onPrimary))).toBeGreaterThanOrEqual(3);
  });

  it('holds for 200 random colours', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const primary = randomHex(seed);
      const theme = deriveTheme({ primary, price: randomHex(seed + 1000) });
      expect(contrast(rgb(theme.primaryText), WHITE), primary).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(theme.price), WHITE), primary).toBeGreaterThanOrEqual(4.5);
      // The better of white and ink always reaches 4.5 against any colour except a narrow
      // mid-grey band, where it still reaches 3 (large text / UI components).
      expect(contrast(rgb(theme.primary), rgb(theme.onPrimary)), primary).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps a primary colour that already passes, and darkens one that does not', () => {
    expect(deriveTheme({ primary: '#E1251B' }).primaryText).toBe('#E1251B');
    const blue = deriveTheme({ primary: '#1DB0FC' });
    expect(blue.primary).toBe('#1DB0FC');
    expect(blue.primaryText).not.toBe('#1DB0FC');
    // design.md's worked example: about #0077B3.
    expect(contrast(rgb(blue.primaryText), WHITE)).toBeLessThan(5);
  });

  it('puts ink on light colours and white on dark ones', () => {
    expect(deriveTheme({ primary: '#FFD400' }).onPrimary).toBe('#1A1A1A');
    expect(deriveTheme({ primary: '#E1251B' }).onPrimary).toBe('#FFFFFF');
  });

  it('falls back: no accent is the primary colour, no price is the primary text colour', () => {
    const theme = deriveTheme({ primary: '#1DB0FC', accent: null, price: '' });
    expect(theme.accent).toBe('#1DB0FC');
    expect(theme.price).toBe(theme.primaryText);
  });

  it('ignores a colour that is not hex', () => {
    expect(deriveTheme({ primary: 'red' }).primary).toBe('#E1251B');
  });

  it('writes a page-style string', () => {
    const style = themeStyle(deriveTheme({ primary: '#E1251B' }), 'small');
    expect(style).toContain('--color-primary:#E1251B');
    expect(style).toContain('--radius-factor:0.5');
    expect(style).not.toContain(' ');
  });
});

describe('themeInputOf', () => {
  it('reads app/config appearance.theme, a null accent as none', () => {
    expect(themeInputOf(appAppearanceDefaults.theme)).toEqual({
      primary: '#E93323',
      accent: null,
      price: '#E93323',
    });
    const theme = deriveTheme(
      themeInputOf({ ...appAppearanceDefaults.theme, accentColor: '#FF7E00' }),
    );
    expect(theme.accent).toBe('#FF7E00');
  });
});

describe('zod-free', () => {
  it('imports nothing at runtime, so the mini-program may ship it', () => {
    const source = readFileSync(new URL('./theme.ts', import.meta.url), 'utf8');
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
  });
});
