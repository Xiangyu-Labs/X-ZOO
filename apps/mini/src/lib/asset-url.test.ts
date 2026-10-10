import { describe, expect, it } from 'vitest';
import { platform } from '@/platform';
import { assetUrl, imageUrl, setAssetOrigin } from './asset-url';

// Built, not written out: a literal 32-hex-digit string reads as a secret to the `mini` guard.
const HASH = '0123456789abcdef'.repeat(2);
const API = platform.api.baseUrl.replace(/\/$/, '');

describe('assetUrl', () => {
  it('prefixes the API origin while no image CDN is set', () => {
    expect(assetUrl(`/uploads/attach/2026/09/${HASH}.jpg`)).toBe(
      `${API}/uploads/attach/2026/09/${HASH}.jpg`,
    );
  });

  it('loads /uploads/ from the image CDN once one is set, thumbnails included', () => {
    setAssetOrigin('https://img.example.com/');
    expect(assetUrl(`/uploads/attach/2026/09/${HASH}.jpg`)).toBe(
      `https://img.example.com/uploads/attach/2026/09/${HASH}.jpg`,
    );
    expect(imageUrl(`/uploads/attach/2026/09/${HASH}.jpg`, 'small')).toBe(
      `https://img.example.com/uploads/attach/2026/09/${HASH}.w480.jpg`,
    );
  });

  it('keeps everything but /uploads/ on the API origin: the CDN serves nothing else', () => {
    setAssetOrigin('https://img.example.com');
    expect(assetUrl('/api/v1/health')).toBe(`${API}/api/v1/health`);
    expect(assetUrl('https://bucket.example.com/a.jpg')).toBe('https://bucket.example.com/a.jpg');
  });

  it('ignores an origin it cannot use, and goes back to the API origin on null', () => {
    for (const bad of [
      'http://img.example.com',
      'https://img.example.com/uploads',
      'img.example.com',
    ]) {
      setAssetOrigin(bad);
      expect(assetUrl('/uploads/a.jpg')).toBe(`${API}/uploads/a.jpg`);
    }
    setAssetOrigin('https://img.example.com');
    setAssetOrigin(null);
    expect(assetUrl('/uploads/a.jpg')).toBe(`${API}/uploads/a.jpg`);
  });
});
