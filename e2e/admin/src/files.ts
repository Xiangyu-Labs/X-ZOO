/**
 * The files the upload specs send.
 *
 * Held as base64 in the source rather than as binaries on disk: a repository
 * that carries a real `.svg` "for testing" eventually has it served, and the
 * point of the upload checks is that such a file never gets in. These are the
 * smallest possible things of each shape.
 */

/** A 1×1 transparent PNG. Real magic bytes, real IHDR, 68 bytes. */
export const PNG = {
  name: 'e2e-pixel.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
};

/**
 * An SVG carrying a script. Declared as `image/svg+xml`, which is what a
 * browser would send — the uploader must refuse it on the *bytes*, not on the
 * declaration, and `file-type.ts` does.
 */
export const SVG_WITH_SCRIPT = {
  name: 'e2e-logo.svg',
  mimeType: 'image/svg+xml',
  buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>',
    'utf8',
  ),
};

/** A PNG renamed and re-declared as a JPEG: the declaration must not win. */
export const PNG_DECLARED_AS_JPEG = {
  name: 'e2e-liar.jpg',
  mimeType: 'image/jpeg',
  buffer: PNG.buffer,
};
