/**
 * What is actually in these bytes?
 *
 * The old uploader trusted the client's `Content-Type` and the filename's
 * extension, which is why `shell.php.jpg` and an SVG full of `<script>` both got
 * in. Nothing here looks at either: the type comes from the leading bytes, and
 * the declared type is only ever *compared* against what was found.
 *
 * Deliberately dependency-free. `sharp` and `file-type` would both do more than
 * this, and both would add a native build step to every CI job and every
 * container image, for a job that is forty bytes of pattern matching. The
 * dimension probe reads the four image headers a shop actually uploads.
 */

export type SniffedKind = 'image' | 'video' | 'audio' | 'file';

export interface SniffResult {
  /** Canonical media type of the bytes, e.g. `image/png`. */
  mime: string;
  extension: string;
  kind: SniffedKind;
}

export interface RejectedResult {
  mime: null;
  /** Why, for the log. Never returned to the caller — see `STORAGE_FILE_TYPE_REJECTED`. */
  reason: string;
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return textDecoder.decode(bytes.subarray(offset, offset + length));
}

/**
 * Types we are willing to store. Everything else is refused, including types
 * that are perfectly harmless — an allow-list that has to be extended on
 * purpose is the only kind that stays correct.
 *
 * **SVG is not here, and will not be.** An SVG is a document: it can carry
 * `<script>`, `<foreignObject>` and external references, and it is served from
 * our own origin. "Sanitise it" is a game nobody has finished winning. Shops
 * that need vector logos upload a PNG.
 */
const SNIFFERS: Array<(b: Uint8Array) => SniffResult | null> = [
  (b) =>
    startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? { mime: 'image/png', extension: 'png', kind: 'image' }
      : null,
  (b) =>
    startsWith(b, [0xff, 0xd8, 0xff])
      ? { mime: 'image/jpeg', extension: 'jpg', kind: 'image' }
      : null,
  (b) =>
    startsWith(b, [0x47, 0x49, 0x46, 0x38])
      ? { mime: 'image/gif', extension: 'gif', kind: 'image' }
      : null,
  (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) && ascii(b, 8, 4) === 'WEBP'
      ? { mime: 'image/webp', extension: 'webp', kind: 'image' }
      : null,
  (b) =>
    startsWith(b, [0x42, 0x4d]) ? { mime: 'image/bmp', extension: 'bmp', kind: 'image' } : null,
  // ISO base media: `....ftyp<brand>`. MP4 and friends.
  (b) => {
    if (!startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return null;
    const brand = ascii(b, 8, 4);
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', extension: 'mp4', kind: 'video' };
    return { mime: 'video/mp4', extension: 'mp4', kind: 'video' };
  },
  (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) && ascii(b, 8, 4) === 'WAVE'
      ? { mime: 'audio/wav', extension: 'wav', kind: 'audio' }
      : null,
  (b) =>
    startsWith(b, [0x49, 0x44, 0x33]) || startsWith(b, [0xff, 0xfb]) || startsWith(b, [0xff, 0xf3])
      ? { mime: 'audio/mpeg', extension: 'mp3', kind: 'audio' }
      : null,
  (b) =>
    startsWith(b, [0x25, 0x50, 0x44, 0x46])
      ? { mime: 'application/pdf', extension: 'pdf', kind: 'file' }
      : null,
];

/**
 * ZIP-container formats share one signature, so they are sniffed together and
 * told apart by the declared type. A bare `.zip` is refused: it is an archive of
 * things we did not inspect.
 */
const OOXML_BY_MIME: Record<string, { extension: string }> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extension: 'xlsx' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extension: 'docx' },
};

/**
 * The shapes we refuse loudly, because they are the ones that were used. Checked
 * *before* the allow-list, so an HTML document whose first bytes happen to look
 * like something else still cannot slip through the `image/*` door.
 */
function looksExecutableOrMarkup(bytes: Uint8Array): string | null {
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<?php') || head.includes('<?php')) return 'php';
  if (head.startsWith('#!')) return 'shebang script';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg/xml';
  if (startsWith(bytes, [0x4d, 0x5a])) return 'windows executable';
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'elf executable';
  if (startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return 'java class / mach-o';
  return null;
}

/**
 * Identifies the bytes, or says why not.
 *
 * `declaredMime` is used for exactly one thing: telling two ZIP-container
 * formats apart. It never *promotes* bytes to a type they do not look like.
 */
export function sniffFileType(
  bytes: Uint8Array,
  declaredMime?: string | undefined,
): SniffResult | RejectedResult {
  if (bytes.length === 0) return { mime: null, reason: 'empty' };

  const dangerous = looksExecutableOrMarkup(bytes);
  if (dangerous) return { mime: null, reason: dangerous };

  for (const sniff of SNIFFERS) {
    const found = sniff(bytes);
    if (found) return found;
  }

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const declared = (declaredMime ?? '').split(';')[0]?.trim() ?? '';
    const ooxml = OOXML_BY_MIME[declared];
    if (ooxml) return { mime: declared, extension: ooxml.extension, kind: 'file' };
    return { mime: null, reason: 'zip container' };
  }

  return { mime: null, reason: 'unrecognised' };
}

export function isRejected(result: SniffResult | RejectedResult): result is RejectedResult {
  return result.mime === null;
}

/**
 * Does the declared type agree with the bytes?
 *
 * Browsers send `image/jpg` for JPEG and occasionally
 * `application/octet-stream` for everything, so an exact string match would
 * reject real uploads. The rule is: no declared type, or a generic one, passes;
 * anything else must name the same type we found.
 */
export function mimeAgrees(declared: string | undefined, detected: string): boolean {
  if (!declared) return true;
  const value = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'application/octet-stream' || value === 'binary/octet-stream') {
    return true;
  }
  if (value === detected) return true;
  // The two spellings of JPEG, and the one browsers get wrong.
  if (detected === 'image/jpeg' && (value === 'image/jpg' || value === 'image/pjpeg')) return true;
  if (detected === 'video/mp4' && value === 'video/quicktime') return true;
  if (detected === 'video/quicktime' && value === 'video/mp4') return true;
  return false;
}

// ---------------------------------------------------------------------------
// dimensions
// ---------------------------------------------------------------------------

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Width and height, read from the header.
 *
 * Returns `null` rather than guessing. A picture whose dimensions we cannot read
 * is still a perfectly good picture; the columns are nullable for that reason.
 */
export function probeImageDimensions(bytes: Uint8Array): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: IHDR is always the first chunk, width/height at 16 and 20.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) && bytes.length >= 24) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }

  // GIF: little-endian 16-bit at 6 and 8.
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // BMP: signed 32-bit at 18 and 22; a negative height means a top-down bitmap.
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length >= 26) {
    return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }

  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP') {
    return probeWebp(bytes, view);
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return probeJpeg(bytes, view);

  return null;
}

/** The three WebP flavours keep their size in three different places. */
function probeWebp(bytes: Uint8Array, view: DataView): Dimensions | null {
  const format = ascii(bytes, 12, 4);
  if (format === 'VP8 ' && bytes.length >= 30) {
    // Lossy: after the 3-byte start code and the 3-byte sync marker.
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (format === 'VP8L' && bytes.length >= 25) {
    // Lossless: 14 bits each, packed across four bytes after the 0x2f signature.
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X' && bytes.length >= 30) {
    // Extended: 24-bit little-endian, stored as (size - 1).
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { width, height };
  }
  return null;
}

/**
 * JPEG: walk the markers to the first SOF segment.
 *
 * Bounded by the buffer length and by a segment counter, because a malformed
 * file must cost microseconds, not a worker.
 */
function probeJpeg(bytes: Uint8Array, view: DataView): Dimensions | null {
  let offset = 2;
  let segments = 0;
  while (offset + 9 < bytes.length && segments < 1024) {
    segments += 1;
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // SOF0..SOF15, except the four that are not frame headers.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: view.getUint16(offset + 5, false),
        width: view.getUint16(offset + 7, false),
      };
    }
    // Start of scan: the entropy-coded data begins, and there is no SOF after it.
    if (marker === 0xda) return null;
    const length = view.getUint16(offset + 2, false);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
