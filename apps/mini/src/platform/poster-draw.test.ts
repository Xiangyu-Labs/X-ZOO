import { describe, expect, it } from 'vitest';
import { coverCrop, fontString } from './poster-draw';
import { saveOutcomeOf } from './poster';

describe('fontString', () => {
  it('is a canvas font shorthand', () => {
    expect(fontString({ size: 30, weight: 'bold' })).toBe('bold 30px sans-serif');
    expect(fontString({ size: 24, weight: 'normal' })).toBe('24px sans-serif');
  });
});

describe('coverCrop', () => {
  it('crops a wide picture to the middle of a square', () => {
    expect(coverCrop({ width: 200, height: 100 }, 50, 50)).toEqual({
      sx: 50,
      sy: 0,
      sw: 100,
      sh: 100,
    });
  });

  it('crops a tall picture to the middle of a square', () => {
    expect(coverCrop({ width: 100, height: 300 }, 50, 50)).toEqual({
      sx: 0,
      sy: 100,
      sw: 100,
      sh: 100,
    });
  });
});

describe('saveOutcomeOf', () => {
  it.each([
    [{ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }, 'denied'],
    [{ errMsg: 'saveImageToPhotosAlbum:fail auth denied' }, 'denied'],
    [{ errMsg: 'saveImageToPhotosAlbum:fail authorize no response' }, 'denied'],
    [{ errMsg: 'saveImageToPhotosAlbum:fail privacy permission is not authorized' }, 'privacy'],
    [{ errMsg: 'saveImageToPhotosAlbum:fail cancel' }, 'cancelled'],
    [{ errMsg: 'saveImageToPhotosAlbum:fail file not exists' }, 'failed'],
  ] as const)('%o → %s', (error, outcome) => {
    expect(saveOutcomeOf(error)).toBe(outcome);
  });
});
