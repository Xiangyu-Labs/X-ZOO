import { readdirSync } from 'node:fs';
import path from 'node:path';

import postcss, { type Plugin } from 'postcss';
import * as sass from 'sass';

/**
 * The stylesheet half of the admin build, shared by `build.ts` (which bundles)
 * and `gen-css-types.ts` (which declares each module's class names).
 */

export const packageRoot = path.resolve(import.meta.dirname, '..');
export const srcRoot = path.join(packageRoot, 'src');

/** The width the blocks are designed on: 750 design px = the screen width. */
export const DESIGN_WIDTH = 750;

/** Every `*.module.scss` under `src/`, sorted. */
export function findCssModules(dir = srcRoot): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findCssModules(full));
    else if (entry.name.endsWith('.module.scss')) found.push(full);
  }
  return found.sort();
}

export function compileScss(file: string): string {
  return sass.compile(file, { style: 'expanded' }).css;
}

const PX = /(-?\d*\.?\d+)px\b/g;

/**
 * `px → vw` on a 750-wide design, the way Taro's `pxtransform` turns the same
 * px into rpx for the mini-program: lower-case `px` only (`PX` / `Px` are left
 * alone, Taro's escape hatch), inside any value, `calc()` included, 5 decimals.
 * `0px` stays `0`. Rendered in a 375px-wide frame, 750 design px = 375 CSS px.
 */
export function pxToVw(designWidth = DESIGN_WIDTH): Plugin {
  const convert = (value: string) =>
    value.replace(PX, (_match, number: string) => {
      const px = Number.parseFloat(number);
      if (px === 0) return '0';
      const vw = Math.round((px / designWidth) * 100 * 1e5) / 1e5;
      return `${vw}vw`;
    });
  return {
    postcssPlugin: 'shop-px-to-vw',
    Declaration(decl) {
      if (decl.value.includes('px')) decl.value = convert(decl.value);
    },
    AtRule(rule) {
      if (rule.name === 'media' && rule.params.includes('px')) rule.params = convert(rule.params);
    },
  };
}

export async function scssToAdminCss(file: string): Promise<string> {
  const css = compileScss(file);
  const result = await postcss([pxToVw()]).process(css, { from: file });
  return result.css;
}

/** The class names a compiled stylesheet defines, sorted. */
export function classNames(css: string): string[] {
  const names = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      if (match[1]) names.add(match[1]);
    }
  });
  return [...names].sort();
}
