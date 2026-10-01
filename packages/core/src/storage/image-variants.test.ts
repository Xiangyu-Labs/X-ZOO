import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isAnimatedPng, renderImageVariants, type RenderOutcome } from './image-variants';

/**
 * The thumbnail renderer against real pictures that sharp itself draws, so the
 * test needs no fixtures on disk and no network.
 */

async function photo(width: number, height: number, orientation?: number): Promise<Buffer> {
  // Noise, not a flat colour: a flat picture compresses to almost nothing and
  // would make every "is it smaller" check meaningless.
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) >>> 24;
  let pipeline = sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 });
  if (orientation !== undefined) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

function variantsOf(outcome: RenderOutcome) {
  if (!outcome.ok) throw new Error(`render failed: ${outcome.reason}`);
  return outcome.variants;
}

describe('renderImageVariants', () => {
  it('resizes a large JPEG to 480 and 960 wide, keeping its aspect and format', async () => {
    const original = await photo(1600, 1000);
    const variants = variantsOf(await renderImageVariants(original, 'image/jpeg'));

    expect(variants.map((v) => v.width)).toEqual([480, 960]);
    for (const variant of variants) {
      const meta = await sharp(variant.body).metadata();
      expect(variant.copied).toBe(false);
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(variant.width);
      expect(meta.height).toBe(Math.round((variant.width * 1000) / 1600));
      expect(variant.body.byteLength).toBeLessThan(original.byteLength);
    }
  });

  it('never enlarges: a picture narrower than a width is stored as it is', async () => {
    const original = await photo(300, 200);
    const variants = variantsOf(await renderImageVariants(original, 'image/jpeg'));
    for (const variant of variants) {
      expect(variant.copied).toBe(true);
      expect(Buffer.from(variant.body).equals(original)).toBe(true);
    }
  });

  it('turns a picture upright by its EXIF orientation and drops the tag', async () => {
    // Stored 1200 × 600, tagged "rotate 90°": a phone shows it 600 wide, 1200 tall.
    const original = await photo(1200, 600, 6);
    const [small] = variantsOf(await renderImageVariants(original, 'image/jpeg'));
    const meta = await sharp(small!.body).metadata();
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(960);
    expect(meta.orientation ?? 1).toBe(1);
  });

  it('keeps a PNG a PNG, transparency included', async () => {
    // A half-transparent gradient: resampled noise would compress worse than
    // the original and be stored as a copy, which is not what this checks.
    const size = 900;
    const raw = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4;
        raw[at] = (x * 255) / size;
        raw[at + 1] = (y * 255) / size;
        raw[at + 2] = ((x + y) * 255) / (2 * size);
        raw[at + 3] = 128;
      }
    }
    const original = await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toBuffer();
    const [small] = variantsOf(await renderImageVariants(original, 'image/png'));
    const meta = await sharp(small!.body).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(480);
    expect(meta.channels).toBe(4);
  });

  it('copies an animated WebP instead of freezing it on its first frame', async () => {
    const frame = (value: number) =>
      sharp({
        create: { width: 800, height: 400, channels: 3, background: { r: value, g: 0, b: 0 } },
      })
        .png()
        .toBuffer();
    const original = await sharp([await frame(10), await frame(200)], { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(original).metadata()).pages).toBe(2);

    const variants = variantsOf(await renderImageVariants(original, 'image/webp'));
    for (const variant of variants) {
      expect(variant.copied).toBe(true);
      expect(Buffer.from(variant.body).equals(original)).toBe(true);
    }
  });

  it('writes nothing for a GIF, a picture too large to decode, or broken bytes', async () => {
    expect(await renderImageVariants(new Uint8Array([0x47, 0x49, 0x46]), 'image/gif')).toEqual({
      ok: false,
      reason: 'unsupported',
    });

    const big = await renderImageVariants(await photo(400, 300), 'image/jpeg', {
      maxInputPixels: 1000,
    });
    expect(big.ok).toBe(false);
    expect(big.ok ? null : big.reason).toMatch(/^(too-large|failed)$/);

    const broken = await renderImageVariants(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
      'image/jpeg',
    );
    expect(broken).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('is a no-op, not a crash, when the native library cannot be loaded', async () => {
    const outcome = await renderImageVariants(await photo(800, 600), 'image/jpeg', {
      loadSharp: async () => null,
    });
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('isAnimatedPng', () => {
  function png(chunks: string[]): Uint8Array {
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    for (const type of chunks) {
      const data = Buffer.alloc(type === 'IHDR' ? 13 : 4);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      parts.push(length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4));
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  it('sees an acTL chunk before the image data', () => {
    expect(isAnimatedPng(png(['IHDR', 'acTL', 'IDAT', 'IEND']))).toBe(true);
    expect(isAnimatedPng(png(['IHDR', 'IDAT', 'IEND']))).toBe(false);
    expect(isAnimatedPng(png(['IHDR', 'IDAT', 'acTL', 'IEND']))).toBe(false);
    expect(isAnimatedPng(new Uint8Array(4))).toBe(false);
  });
});
