/**
 * Image variants: the smaller copies of an uploaded picture that lists load
 * instead of the original.
 *
 * The naming is deterministic, so **nothing in the API carries a variant URL**:
 * the server stores `…/<32 hex>.w480.jpg` next to `…/<32 hex>.jpg`, and the
 * client derives one from the other. A variant is written only for a key the
 * server generated itself (`<directory>/<yyyy>/<mm>/<32 hex>.<ext>`, see
 * `buildStorageKey` in `core/src/kernel/storage.ts`), and only for the formats
 * it re-encodes as themselves: JPEG, PNG and WebP. A GIF, a BMP, a path
 * migrated from the old system or someone else's host never matches, so the
 * client never asks for a copy that cannot exist.
 *
 * A variant can still be missing (an upload made before variants existed and
 * not yet backfilled, a failed generation, a job still queued), so a client
 * that shows one falls back to the original when it fails to load.
 *
 * Zod-free (no imports), so the mini-program can call it at run time.
 */

/**
 * The widths generated, in device pixels: 480 covers up to a third of a phone
 * screen at 3× (a list row, a three-column cell), 960 a half at 3× (a
 * two-column card) or the full width at about 2.5× (a banner).
 */
export const IMAGE_VARIANT_WIDTHS = [480, 960] as const;
export type ImageVariantWidth = (typeof IMAGE_VARIANT_WIDTHS)[number];

const EXTENSIONS = 'jpg|jpeg|png|webp';
/** `product/2026/02/<32 hex>.jpg`: a key `buildStorageKey` wrote. */
const STORED_KEY = new RegExp(`^([a-z0-9-]{1,32}/\\d{4}/\\d{2}/[0-9a-f]{32})\\.(${EXTENSIONS})$`);
/** The same key at the end of a URL (`/uploads/…`, or a bucket's public base). */
const STORED_URL = new RegExp(`(/[a-z0-9-]{1,32}/\\d{4}/\\d{2}/[0-9a-f]{32})\\.(${EXTENSIONS})$`);
const VARIANT_URL = new RegExp(
  `(/[a-z0-9-]{1,32}/\\d{4}/\\d{2}/[0-9a-f]{32})\\.w(${IMAGE_VARIANT_WIDTHS.join('|')})\\.(${EXTENSIONS})$`,
);

function isVariantWidth(width: number): width is ImageVariantWidth {
  return (IMAGE_VARIANT_WIDTHS as readonly number[]).includes(width);
}

/** Whether variants are generated for this storage key. */
export function hasImageVariants(key: string): boolean {
  return STORED_KEY.test(key);
}

/** `product/2026/02/ab…cd.jpg` → `product/2026/02/ab…cd.w480.jpg`; `null` for any other key. */
export function imageVariantKey(key: string, width: ImageVariantWidth): string | null {
  if (!isVariantWidth(width)) return null;
  const match = STORED_KEY.exec(key);
  return match ? `${match[1]}.w${width}.${match[2]}` : null;
}

/**
 * The variant's URL for an original's URL, or `null` when the URL is not one
 * of ours or carries a query or fragment (a signed or processed URL is left
 * alone).
 */
export function imageVariantUrl(url: string, width: ImageVariantWidth): string | null {
  if (!isVariantWidth(width) || url.includes('?') || url.includes('#')) return null;
  const match = STORED_URL.exec(url);
  if (!match) return null;
  return `${url.slice(0, match.index)}${match[1]}.w${width}.${match[2]}`;
}

/** The original's URL for a variant's URL, or `null` when it is not a variant URL. */
export function originalImageUrl(url: string): string | null {
  if (url.includes('?') || url.includes('#')) return null;
  const match = VARIANT_URL.exec(url);
  if (!match) return null;
  return `${url.slice(0, match.index)}${match[1]}.${match[3]}`;
}
