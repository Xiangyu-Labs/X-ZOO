import { describe, expect, it } from 'vitest';
import { base64Ascii, ICONS } from './icons';

describe('block icons', () => {
  it('encodes ASCII exactly as base64 does, at every padding length', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', '<svg stroke="#1A1A1A"/>']) {
      expect(base64Ascii(text)).toBe(Buffer.from(text, 'ascii').toString('base64'));
    }
  });

  it('ships every icon as a base64 SVG that decodes to the markup', () => {
    for (const uri of Object.values(ICONS)) {
      expect(uri).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
      const svg = Buffer.from(uri.split(',')[1]!, 'base64').toString('ascii');
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg".*<\/svg>$/);
    }
  });
});
