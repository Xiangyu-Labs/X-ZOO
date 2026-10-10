import { imageVariantUrl, type ImageVariantWidth } from '@shop/contracts/storage/image-variants';
import { platform } from '@/platform';

/** The image CDN in front of `/uploads/` (`appConfig.assetOrigin`), or `null` for the API origin. */
let uploadsOrigin: string | null = null;

/**
 * Load `/uploads/…` from `origin` from now on (存储设置 › 图片 CDN 域名), or from the API origin
 * again for `null`. Anything but a bare https origin is ignored: a wrong prefix would break
 * every picture at once, and the API origin always works.
 */
export function setAssetOrigin(origin: string | null | undefined): void {
  const value = (origin ?? '').replace(/\/+$/, '');
  uploadsOrigin = /^https:\/\/[a-z0-9.-]+$/i.test(value) ? value : null;
}

/**
 * An uploaded file's URL as the page can load it. The server hands out paths relative to the
 * shop's origin (`/uploads/…`); the mini-program has no origin of its own, so it prefixes the
 * image CDN's when one is set, else the API origin. Only `/uploads/` goes to the CDN: it serves
 * nothing else. Absolute URLs and `null` pass through.
 */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:)?\/\//.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }
  const relative = path.startsWith('/') ? path : `/${path}`;
  if (uploadsOrigin !== null && relative.startsWith('/uploads/')) return uploadsOrigin + relative;
  return platform.api.baseUrl.replace(/\/$/, '') + relative;
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
