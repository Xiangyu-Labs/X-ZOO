'use client';

import { useState, type ImgHTMLAttributes } from 'react';
import { imageVariantUrl, type ImageVariantWidth } from '@shop/contracts/storage/image-variants';

/**
 * The server's 480 or 960 px copy of an uploaded picture (`….w480.png`), or the picture itself
 * when it has no copies (another site's URL, a GIF, a legacy path). The same rule the
 * mini-program loads by.
 *
 * Originals run to megabytes: the 装修 canvas once pulled 7.5 MB of 图片魔方 PNGs that it draws
 * at 180 px, and every request after them on the same connection waited.
 */
export function imageCopyUrl(url: string, width: ImageVariantWidth): string {
  return imageVariantUrl(url, width) ?? url;
}

export interface CopyImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  src: string;
  alt: string;
  /** Which copy to load. Default 480: anything drawn under about 240 CSS px. */
  copy?: ImageVariantWidth | undefined;
}

/**
 * An `<img>` that loads the smaller copy and falls back to the original when the copy is missing
 * (an upload whose copies are not written yet).
 */
export function CopyImage({ src, alt, copy = 480, onError, ...rest }: CopyImageProps) {
  const preferred = imageCopyUrl(src, copy);
  // Names the URL that failed, so a new `src` starts over on its own.
  const [failed, setFailed] = useState<string | null>(null);
  const shown = failed === preferred ? src : preferred;
  return (
    <img
      {...rest}
      src={shown}
      alt={alt}
      onError={(event) => {
        if (shown !== src) setFailed(preferred);
        else onError?.(event);
      }}
    />
  );
}
