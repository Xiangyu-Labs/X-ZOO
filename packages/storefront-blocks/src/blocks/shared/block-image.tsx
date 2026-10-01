import { Image } from '@tarojs/components';
import { useState } from 'react';

import type { BlockImageWidth, ImageResolver } from './types';

type ImageMode = 'aspectFill' | 'aspectFit' | 'widthFix';

export interface BlockImageProps {
  src: string;
  /** The copy to ask the host for; absent loads the original. */
  width?: BlockImageWidth | undefined;
  resolve?: ImageResolver | undefined;
  className?: string | undefined;
  mode: ImageMode;
  /** WeChat's `lazy-load`: loads once within a few screens of the viewport. */
  lazyLoad?: boolean | undefined;
  ariaLabel?: string | undefined;
  onClick?: (() => void) | undefined;
}

/**
 * A block's picture: Taro's `<Image>` exactly as the block drew it before,
 * with its source resolved by the host (`BlockHost.resolveImage`) and a second
 * chance — when the smaller copy fails to load (an old upload with no copies
 * yet), it switches to the original instead of leaving the box empty.
 *
 * The box is still sized by the block's own class, so nothing here changes the
 * layout, before or after the picture arrives.
 */
export function BlockImage({
  src,
  width,
  resolve,
  className,
  mode,
  lazyLoad,
  ariaLabel,
  onClick,
}: BlockImageProps) {
  const original = resolve ? resolve(src) : src;
  const preferred = resolve && width ? resolve(src, width) : original;
  const [failed, setFailed] = useState<string | null>(null);
  // `failed` names the URL that failed, so a new `src` starts over on its own.
  const shown = failed === preferred ? original : preferred;
  return (
    <Image
      {...(className ? { className } : {})}
      src={shown}
      mode={mode}
      {...(lazyLoad ? { lazyLoad: true } : {})}
      {...(ariaLabel ? { ariaLabel } : {})}
      {...(onClick ? { onClick } : {})}
      {...(shown !== original ? { onError: () => setFailed(preferred) } : {})}
    />
  );
}
