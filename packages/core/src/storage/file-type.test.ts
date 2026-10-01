import { describe, expect, it } from 'vitest';
import { isRejected, mimeAgrees, probeImageDimensions, sniffFileType } from './file-type';

/**
 * The upload defence, tested from the attacker's side.
 *
 * Every case in the first block is a file an uploader that trusted the
 * extension and the client's `Content-Type` would accept.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A minimal but structurally real 1×1 PNG. */
function png(width = 1, height = 1): Uint8Array {
  const out = new Uint8Array(24);
  out.set(PNG_HEADER, 0);
  const view = new DataView(out.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return out;
}

describe('sniffFileType — the files that must never get in', () => {
  it('refuses a PHP script however it is named or declared', () => {
    const result = sniffFileType(text('<?php system($_GET["c"]); ?>'), 'image/png');
    expect(isRejected(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('php');
  });

  it('refuses PHP hidden after leading whitespace', () => {
    expect(isRejected(sniffFileType(text('   \n\n<?php echo 1;')))).toBe(true);
  });

  it('refuses HTML, which would run as our own origin', () => {
    expect(isRejected(sniffFileType(text('<!DOCTYPE html><html><body>')))).toBe(true);
    expect(isRejected(sniffFileType(text('<html><script>alert(1)</script>')))).toBe(true);
  });

  it('refuses SVG — always, script or not', () => {
    // SVG is a document that can carry <script>, <foreignObject> and external
    // references, and it is served from our own origin. There is no allowed SVG.
    expect(isRejected(sniffFileType(text('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe(true);
    expect(isRejected(sniffFileType(text('<?xml version="1.0"?><svg/>'), 'image/svg+xml'))).toBe(
      true,
    );
  });

  it('refuses executables', () => {
    expect(isRejected(sniffFileType(bytes(0x4d, 0x5a, 0x90, 0x00)))).toBe(true); // PE
    expect(isRejected(sniffFileType(bytes(0x7f, 0x45, 0x4c, 0x46)))).toBe(true); // ELF
    expect(isRejected(sniffFileType(text('#!/bin/sh\nrm -rf /')))).toBe(true);
  });

  it('refuses a bare zip: an archive of things nobody inspected', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    expect(isRejected(sniffFileType(zip))).toBe(true);
    expect(isRejected(sniffFileType(zip, 'application/zip'))).toBe(true);
  });

  it('refuses an empty file and an unrecognised one', () => {
    expect(isRejected(sniffFileType(new Uint8Array()))).toBe(true);
    expect(isRejected(sniffFileType(bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05)))).toBe(true);
  });
});

describe('sniffFileType — the files a shop actually uploads', () => {
  it('identifies the image formats by their leading bytes', () => {
    expect(sniffFileType(png())).toMatchObject({ mime: 'image/png', kind: 'image' });
    expect(sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({ mime: 'image/jpeg' });
    expect(sniffFileType(text('GIF89a'))).toMatchObject({ mime: 'image/gif' });
    expect(sniffFileType(bytes(0x42, 0x4d, 0x36))).toMatchObject({ mime: 'image/bmp' });
  });

  it('identifies WebP, which shares its container with WAV', () => {
    const webp = new Uint8Array(16);
    webp.set(text('RIFF'), 0);
    webp.set(text('WEBP'), 8);
    expect(sniffFileType(webp)).toMatchObject({ mime: 'image/webp', kind: 'image' });

    const wav = new Uint8Array(16);
    wav.set(text('RIFF'), 0);
    wav.set(text('WAVE'), 8);
    expect(sniffFileType(wav)).toMatchObject({ mime: 'audio/wav', kind: 'audio' });
  });

  it('identifies MP4 by its ftyp box, not by its extension', () => {
    const mp4 = new Uint8Array(16);
    mp4.set(text('ftyp'), 4);
    mp4.set(text('isom'), 8);
    expect(sniffFileType(mp4)).toMatchObject({ mime: 'video/mp4', kind: 'video' });
  });

  it('tells the two OOXML formats apart only by the declared type', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    expect(
      sniffFileType(zip, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toMatchObject({ extension: 'xlsx', kind: 'file' });
  });
});

describe('mimeAgrees', () => {
  it('accepts the spellings browsers actually send', () => {
    expect(mimeAgrees('image/jpg', 'image/jpeg')).toBe(true);
    expect(mimeAgrees('image/pjpeg', 'image/jpeg')).toBe(true);
    expect(mimeAgrees('application/octet-stream', 'image/png')).toBe(true);
    expect(mimeAgrees(undefined, 'image/png')).toBe(true);
    expect(mimeAgrees('image/png; charset=binary', 'image/png')).toBe(true);
  });

  it('refuses a real mismatch rather than silently correcting it', () => {
    // A PNG declared as a PDF is either a broken client or an attempt. Either
    // way it is not something to guess about.
    expect(mimeAgrees('application/pdf', 'image/png')).toBe(false);
    expect(mimeAgrees('text/html', 'image/png')).toBe(false);
  });
});

describe('probeImageDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(probeImageDimensions(png(750, 390))).toEqual({ width: 750, height: 390 });
  });

  it('reads GIF dimensions little-endian', () => {
    const gif = new Uint8Array(12);
    gif.set(text('GIF89a'), 0);
    new DataView(gif.buffer).setUint16(6, 300, true);
    new DataView(gif.buffer).setUint16(8, 200, true);
    expect(probeImageDimensions(gif)).toEqual({ width: 300, height: 200 });
  });

  it('reads a JPEG SOF0 frame header', () => {
    // SOI, an APP0 segment to walk past, then SOF0 carrying 64×48.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30,
      0x00, 0x40, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(probeImageDimensions(jpeg)).toEqual({ width: 64, height: 48 });
  });

  it('returns null rather than guessing', () => {
    // A picture whose header we cannot read is still a good picture; the
    // columns are nullable for exactly this case.
    expect(probeImageDimensions(bytes(0xff, 0xd8, 0xff))).toBeNull();
    expect(probeImageDimensions(text('%PDF-1.4'))).toBeNull();
  });

  it('gives up on a malformed JPEG instead of looping', () => {
    // 0xff 0xff repeated forever is a marker that never resolves.
    const malformed = new Uint8Array(4096).fill(0xff);
    malformed[0] = 0xff;
    malformed[1] = 0xd8;
    expect(probeImageDimensions(malformed)).toBeNull();
  });
});
