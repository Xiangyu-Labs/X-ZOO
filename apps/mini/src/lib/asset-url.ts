import { imageVariantUrl, type ImageVariantWidth } from '@shop/contracts/storage/image-variants';
import { platform } from '@/platform';

/**
 * An uploaded file's URL as the page can load it. The server hands out paths relative to the
 * shop's origin (`/uploads/…`); the mini-program has no origin of its own, so it prefixes the
 * API origin. Absolute URLs and `null` pass through.
 */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:)?\/\//.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }
  const base = platform.api.baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Which copy of an uploaded picture a spot loads (docs/mini/status/P2-images.md):
 *
 * - `small` (480 px wide): up to about a third of the screen at 3× — a cart, order or after-sale row, a
 *   three-column cell, a review thumbnail, an icon;
 * - `medium` (960 px): half the screen at 3×, the full width at about 2.5× — a two-column card, a
 *   banner;
 * - `original`: where the picture is the point — the product gallery, a full-screen preview.
 */
export type ImageSize = 'small' | 'medium' | 'original';

export const IMAGE_SIZE_WIDTH: Record<Exclude<ImageSize, 'original'>, ImageVariantWidth> = {
  small: 480,
  medium: 960,
};

/**
 * The URL to load for `size`: the server's smaller copy when the picture is one of our uploads
 * that has copies (JPEG, PNG, WebP), else the original. A copy can still be missing (an old
 * upload not yet backfilled), so whoever shows it falls back to `assetUrl(path)` on error.
 */
export function imageUrl(path: string | null | undefined, size: ImageSize): string | null {
  const original = assetUrl(path);
  if (!original || size === 'original') return original;
  return imageVariantUrl(original, IMAGE_SIZE_WIDTH[size]) ?? original;
}
