import { describe, expect, it } from 'vitest';
import {
  hasImageVariants,
  imageVariantKey,
  imageVariantUrl,
  originalImageUrl,
} from './image-variants';

const HEX = '0123456789abcdef0123456789abcdef';

describe('image variant naming', () => {
  it('derives the variant key next to a key the server generated', () => {
    expect(imageVariantKey(`product/2026/02/${HEX}.jpg`, 480)).toBe(
      `product/2026/02/${HEX}.w480.jpg`,
    );
    expect(imageVariantKey(`review/2026/09/${HEX}.png`, 960)).toBe(
      `review/2026/09/${HEX}.w960.png`,
    );
    expect(hasImageVariants(`attachment/2026/09/${HEX}.webp`)).toBe(true);
  });

  it('has no variant for a GIF, a BMP, a non-image or a legacy path', () => {
    for (const key of [
      `product/2026/02/${HEX}.gif`,
      `product/2026/02/${HEX}.bmp`,
      `product/2026/02/${HEX}.pdf`,
      `attach/2022/08/20220815/${HEX}.jpg`,
      `product/2026/02/not-a-hash.jpg`,
      `product/2026/02/${HEX}.w480.jpg`,
    ]) {
      expect(hasImageVariants(key)).toBe(false);
      expect(imageVariantKey(key, 480)).toBeNull();
    }
  });

  it('refuses a width it does not generate', () => {
    expect(imageVariantKey(`product/2026/02/${HEX}.jpg`, 500 as 480)).toBeNull();
    expect(imageVariantUrl(`/uploads/product/2026/02/${HEX}.jpg`, 500 as 480)).toBeNull();
  });

  it('derives the variant URL for the local driver and a bucket domain', () => {
    expect(imageVariantUrl(`/uploads/product/2026/02/${HEX}.jpg`, 480)).toBe(
      `/uploads/product/2026/02/${HEX}.w480.jpg`,
    );
    expect(
      imageVariantUrl(`https://api.example.com/uploads/product/2026/02/${HEX}.jpeg`, 960),
    ).toBe(`https://api.example.com/uploads/product/2026/02/${HEX}.w960.jpeg`);
    expect(imageVariantUrl(`https://cdn.example.com/shop/attachment/2026/02/${HEX}.png`, 480)).toBe(
      `https://cdn.example.com/shop/attachment/2026/02/${HEX}.w480.png`,
    );
  });

  it('leaves alone a URL that is not ours, or is signed or processed', () => {
    for (const url of [
      'https://thirdwx.qlogo.cn/mmopen/abc/132',
      `https://example.com/uploads/attach/2022/08/20220815/${HEX}.jpg`,
      `/uploads/product/2026/02/${HEX}.gif`,
      `/uploads/product/2026/02/${HEX}.jpg?x-oss-process=image/resize,w_100`,
      `/uploads/product/2026/02/${HEX}.jpg#top`,
      `/uploads/product/2026/02/${HEX}.w480.jpg`,
      'data:image/svg+xml,<svg/>',
    ]) {
      expect(imageVariantUrl(url, 480)).toBeNull();
    }
  });

  it('maps a variant URL back to its original, and nothing else', () => {
    expect(originalImageUrl(`/uploads/review/2026/09/${HEX}.w480.jpg`)).toBe(
      `/uploads/review/2026/09/${HEX}.jpg`,
    );
    expect(originalImageUrl(`https://cdn.example.com/review/2026/09/${HEX}.w960.webp`)).toBe(
      `https://cdn.example.com/review/2026/09/${HEX}.webp`,
    );
    expect(originalImageUrl(`/uploads/review/2026/09/${HEX}.jpg`)).toBeNull();
    expect(originalImageUrl(`/uploads/review/2026/09/${HEX}.w500.jpg`)).toBeNull();
    expect(originalImageUrl(`/uploads/review/2026/09/${HEX}.w360.jpg`)).toBeNull();
    expect(originalImageUrl(`/uploads/review/2026/09/${HEX}.w750.jpg`)).toBeNull();
    expect(originalImageUrl(`/uploads/review/2026/09/${HEX}.w480.gif`)).toBeNull();
  });
});
