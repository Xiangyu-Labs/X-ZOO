import { useState } from 'react';
import { Image as TaroImage, View } from '@tarojs/components';
import { assetUrl, imageUrl, type ImageSize } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { Icon } from './icon';
import './image.scss';

export interface ImageProps {
  /** An absolute URL or a server path (`/uploads/…`); `null` shows the placeholder. */
  src: string | null | undefined;
  /** What the picture shows (a product's name). Without it the image is decoration. */
  label?: string | undefined;
  /** width / height; the box keeps it before the picture arrives. Default 1 (square). */
  ratio?: number | undefined;
  /** `cover` crops to fill (default); `contain` shows it whole. */
  fit?: 'cover' | 'contain' | undefined;
  /** Rounded corners, following the shop's roundness. */
  radius?: 'none' | 'sm' | 'md' | undefined;
  /** Load when near the viewport (lists). Default on. */
  lazy?: boolean | undefined;
  /**
   * Which copy to load (`lib/asset-url`): `small` or `medium` for a list, card or thumbnail,
   * `original` (default) where the picture is the point. A missing copy falls back to the original.
   */
  size?: ImageSize | undefined;
  /**
   * What stands in when there is no picture or it fails: a plain picture outline (default), or
   * a person for an avatar. Never a 「添加图片」 sign: the shopper cannot add one here.
   */
  placeholder?: 'image' | 'user' | undefined;
  className?: string | undefined;
}

/**
 * A picture in a fixed-ratio box (design.md §4.1): grey while it loads, a neutral icon if it fails.
 * The box is sized by CSS, not by the image, so a list does not jump as pictures arrive. Its
 * height is a padding share of the *parent's* width: give a fixed-width picture a wrapper of
 * that width rather than a width on the Image itself.
 */
export function Image({
  src,
  label,
  ratio = 1,
  fit = 'cover',
  radius = 'none',
  lazy = true,
  size = 'original',
  placeholder = 'image',
  className,
}: ImageProps) {
  const original = assetUrl(src ?? null);
  const preferred = imageUrl(src ?? null, size);
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  // The smaller copy failed (not generated yet, or never): show the original instead.
  const [fellBack, setFellBack] = useState(false);
  const [shownUrl, setShownUrl] = useState(original);
  if (shownUrl !== original) {
    setShownUrl(original);
    setState('loading');
    setFellBack(false);
  }
  const url = fellBack ? original : preferred;
  const failed = !url || state === 'error';
  return (
    <View
      className={cx(
        'shop-image',
        `shop-image--radius-${radius}`,
        state === 'loaded' && 'shop-image--loaded',
        className,
      )}
      style={{ paddingTop: `${(100 / ratio).toFixed(4)}%` }}
      {...(label ? { ariaRole: 'img', ariaLabel: label } : { ariaHidden: true })}
    >
      {failed ? (
        <View className="shop-image__fallback">
          <Icon name={placeholder} />
        </View>
      ) : (
        <TaroImage
          className="shop-image__img"
          src={url}
          mode={fit === 'cover' ? 'aspectFill' : 'aspectFit'}
          lazyLoad={lazy}
          ariaHidden
          onLoad={() => setState('loaded')}
          onError={() => (url !== original && !fellBack ? setFellBack(true) : setState('error'))}
        />
      )}
    </View>
  );
}
