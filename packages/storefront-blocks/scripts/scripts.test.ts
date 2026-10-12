import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { findCssModules, pxToVw } from './css-modules';
import { declarationFor, declarationPath } from './gen-css-types';

describe('px → vw (the admin canvas stylesheet)', () => {
  const convert = async (css: string) =>
    (await postcss([pxToVw()]).process(css, { from: undefined })).css;

  it('maps 750 design px onto the viewport width, like Taro maps them onto rpx', async () => {
    expect(await convert('a{width:750px;padding:20px 0 10px}')).toBe(
      'a{width:100vw;padding:2.66667vw 0 1.33333vw}',
    );
    expect(await convert('a{height:calc(var(--sb-height) * 750px / 750)}')).toBe(
      'a{height:calc(var(--sb-height) * 100vw / 750)}',
    );
  });

  it('leaves upper-case PX alone, Taro’s escape hatch', async () => {
    expect(await convert('a{border:1PX solid red}')).toBe('a{border:1PX solid red}');
  });
});

describe('design numbers in a stylesheet', () => {
  /**
   * WeChat turns each rpx length into px on its own and rounds it down, and a length under 1px
   * becomes 1px on Android: `* 1rpx` is 0.5px on a 375pt phone, so `var(--sb-height) * 1px`
   * drew every 轮播 and 图片魔方 twice its height there. `* 750px / 750` is one full-width
   * length (750rpx), which rounds to the pixel.
   */
  it('are scaled through 750px, never 1px', () => {
    for (const file of findCssModules()) {
      const css = readFileSync(file, 'utf8');
      expect(css, file).not.toMatch(/var\(--sb-[\w-]+\)\s*\*\s*1px/);
    }
  });
});

describe('the committed *.module.scss.d.ts', () => {
  it('declare exactly the classes each stylesheet defines (run `pnpm gen` if this fails)', () => {
    for (const file of findCssModules()) {
      expect(readFileSync(declarationPath(file), 'utf8'), file).toBe(declarationFor(file));
    }
  });
});
