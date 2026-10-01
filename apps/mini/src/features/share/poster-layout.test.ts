import { describe, expect, it } from 'vitest';
import {
  POSTER_WIDTH,
  posterLayout,
  wrapText,
  type DrawOp,
  type Measure,
  type PosterColors,
} from './poster-layout';

/** Every character is `size` wide: easy to reason about. */
const measure: Measure = (text, font) => [...text].length * font.size;

const colors: PosterColors = {
  background: '#ffffff',
  text: '#1a1a1a',
  muted: '#999999',
  price: '#e93323',
  primary: '#e93323',
  placeholder: '#f2f2f2',
};

const texts = (ops: DrawOp[]) => ops.flatMap((op) => (op.op === 'text' ? [op.text] : []));

describe('wrapText', () => {
  const font = { size: 10, weight: 'normal' } as const;

  it('keeps a short text on one line', () => {
    expect(wrapText('护理套装', 100, 2, font, measure)).toEqual(['护理套装']);
  });

  it('breaks by character and ends an overflowing last line with an ellipsis', () => {
    expect(wrapText('一二三四五六七八九十', 40, 2, font, measure)).toEqual(['一二三四', '五六七…']);
  });

  it('never returns an empty text as a line', () => {
    expect(wrapText('   ', 40, 2, font, measure)).toEqual([]);
  });
});

describe('posterLayout', () => {
  const content = {
    shopName: '小店',
    title: '双人团 · 护理套装',
    price: '68.00',
    originalPrice: '98.00',
    badge: '2 人团 · 还差 1 人成团',
  };

  it('draws the image, name, price, badge, code and hint, and nothing personal', () => {
    const layout = posterLayout(content, colors, measure);
    expect(layout.width).toBe(POSTER_WIDTH);
    expect(layout.ops[0]).toMatchObject({
      op: 'rect',
      x: 0,
      y: 0,
      w: POSTER_WIDTH,
      h: layout.height,
    });
    const images = layout.ops.flatMap((op) => (op.op === 'image' ? [op.key] : []));
    expect(images).toEqual(['product', 'code']);
    expect(texts(layout.ops)).toEqual([
      '小店',
      '双人团 · 护理套装',
      '¥',
      '68.00',
      '¥98.00',
      '2 人团 · 还差 1 人成团',
      '长按识别小程序码',
      '来自 小店',
    ]);
  });

  it('keeps everything inside the poster', () => {
    const layout = posterLayout(content, colors, measure);
    for (const op of layout.ops) {
      if (op.op === 'rect' || op.op === 'image') {
        expect(op.x + op.w).toBeLessThanOrEqual(layout.width);
        expect(op.y + op.h).toBeLessThanOrEqual(layout.height);
      }
      if (op.op === 'text') expect(op.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it('leaves the image out on request, and the poster gets shorter', () => {
    const withImage = posterLayout(content, colors, measure);
    const without = posterLayout({ ...content, hideImage: true }, colors, measure);
    expect(without.ops.some((op) => op.op === 'image' && op.key === 'product')).toBe(false);
    expect(without.height).toBeLessThan(withImage.height);
  });

  it('shows no struck-through price that is not above the price, and no empty badge', () => {
    const layout = posterLayout(
      { shopName: '小店', title: '护理套装', price: '68.00', originalPrice: '68.00' },
      colors,
      measure,
    );
    expect(texts(layout.ops)).not.toContain('¥68.00');
    expect(layout.ops.filter((op) => op.op === 'line')).toHaveLength(1);
  });

  it('paints the price in the theme price colour', () => {
    const layout = posterLayout(content, colors, measure);
    const price = layout.ops.find((op) => op.op === 'text' && op.text === '68.00');
    expect(price).toMatchObject({ color: colors.price });
  });
});
