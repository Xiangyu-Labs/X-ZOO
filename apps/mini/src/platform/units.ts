import Taro from '@tarojs/taro';

/**
 * A design size (750-wide px) for an inline style: `rpx` in the mini-program, `rem` on H5.
 * Stylesheets need no call (pxtransform rewrites `px` at build time); inline styles do
 * (docs/mini/design.md: a guard rejects bare `NNpx` strings in `style`).
 */
export function px(size: number): string {
  return Taro.pxTransform(size);
}
