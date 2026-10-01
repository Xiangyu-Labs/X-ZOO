/**
 * The share poster's layout (design.md §4.4, C10), as draw operations: a pure function of what
 * the poster says, its colours and a text measurer, so it is tested without a canvas and the
 * platform only replays the list (`platform/poster.ts`).
 *
 * What a poster carries is fixed and restrained: the product image (which the shopper may leave
 * out), the name, the price, a factual group-buy line, the 小程序码 and 「长按识别小程序码」.
 * No avatar or nickname, no slogan, no "share to unlock".
 */

import { strikePrice } from '@/lib/money';

export const POSTER_WIDTH = 600;
const PAD = 32;
const INNER = POSTER_WIDTH - PAD * 2;
const CODE = 168;

export interface PosterContent {
  /** The shop's name, at the top and beside the code. */
  shopName: string;
  title: string;
  /** `"68.00"`. */
  price: string;
  /** Struck through beside the price; left out when it is not above the price. */
  originalPrice?: string | null | undefined;
  /** A factual line under the price: 「2 人团 · 还差 1 人成团」. */
  badge?: string | undefined;
  /** Leave the product image out (the shopper's choice on the sheet). */
  hideImage?: boolean | undefined;
}

export interface PosterColors {
  background: string;
  text: string;
  muted: string;
  price: string;
  primary: string;
  /** Behind the image while it is missing, and the divider. */
  placeholder: string;
}

export interface Font {
  size: number;
  weight: 'normal' | 'bold';
}

/** `measure(text, font)` → the width the canvas would draw it at. */
export type Measure = (text: string, font: Font) => number;

export type PosterImageKey = 'product' | 'code';

export type DrawOp =
  | { op: 'rect'; x: number; y: number; w: number; h: number; color: string; radius?: number }
  | {
      op: 'image';
      key: PosterImageKey;
      x: number;
      y: number;
      w: number;
      h: number;
      radius?: number;
    }
  | {
      op: 'text';
      text: string;
      x: number;
      y: number;
      font: Font;
      color: string;
      /** The x is the start (left) or the end (right) of the text. */
      align?: 'left' | 'right';
    }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number };

export interface PosterLayout {
  width: number;
  height: number;
  ops: DrawOp[];
}

/**
 * Breaks `text` into at most `maxLines` lines no wider than `maxWidth`, character by character
 * (Chinese has no spaces to break at); the last line ends in 「…」 when the text does not fit.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  maxLines: number,
  font: Font,
  measure: Measure,
): string[] {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  const lines: string[] = [];
  let line = '';
  let index = 0;
  while (index < chars.length && lines.length < maxLines) {
    const next = line + chars[index];
    if (measure(next, font) <= maxWidth || line === '') {
      line = next;
      index += 1;
      continue;
    }
    lines.push(line);
    line = '';
  }
  if (line !== '' && lines.length < maxLines) lines.push(line);
  if (index < chars.length && lines.length > 0) {
    let last = lines[lines.length - 1] ?? '';
    while (last.length > 0 && measure(`${last}…`, font) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

const SHOP: Font = { size: 24, weight: 'normal' };
const TITLE: Font = { size: 30, weight: 'bold' };
const YUAN: Font = { size: 28, weight: 'bold' };
const PRICE: Font = { size: 52, weight: 'bold' };
const STRIKE: Font = { size: 24, weight: 'normal' };
const BADGE: Font = { size: 26, weight: 'normal' };
const HINT: Font = { size: 26, weight: 'bold' };
const HINT_SUB: Font = { size: 22, weight: 'normal' };

/** The poster: shop name, image, name, price, badge, then the code with its hint. */
export function posterLayout(
  content: PosterContent,
  colors: PosterColors,
  measure: Measure,
): PosterLayout {
  const ops: DrawOp[] = [];
  let y = PAD;

  // Shop name (baseline-positioned text: y is the baseline).
  y += SHOP.size;
  ops.push({ op: 'text', text: content.shopName, x: PAD, y, font: SHOP, color: colors.muted });
  y += 20;

  if (!content.hideImage) {
    ops.push({ op: 'rect', x: PAD, y, w: INNER, h: INNER, color: colors.placeholder, radius: 16 });
    ops.push({ op: 'image', key: 'product', x: PAD, y, w: INNER, h: INNER, radius: 16 });
    y += INNER + 32;
  } else {
    y += 16;
  }

  for (const line of wrapText(content.title, INNER, 2, TITLE, measure)) {
    y += TITLE.size;
    ops.push({ op: 'text', text: line, x: PAD, y, font: TITLE, color: colors.text });
    y += 12;
  }

  // Price row: ¥ + amount in the price colour, the original price struck through after it.
  y += 16 + PRICE.size;
  const yuanWidth = measure('¥', YUAN);
  ops.push({ op: 'text', text: '¥', x: PAD, y, font: YUAN, color: colors.price });
  const priceX = PAD + yuanWidth + 4;
  ops.push({ op: 'text', text: content.price, x: priceX, y, font: PRICE, color: colors.price });
  const original = strikePrice(content.price, content.originalPrice);
  if (original) {
    const text = `¥${original}`;
    const x = priceX + measure(content.price, PRICE) + 16;
    const width = measure(text, STRIKE);
    ops.push({ op: 'text', text, x, y, font: STRIKE, color: colors.muted });
    const mid = y - STRIKE.size / 3;
    ops.push({ op: 'line', x1: x, y1: mid, x2: x + width, y2: mid, color: colors.muted, width: 2 });
  }

  if (content.badge) {
    y += 20 + BADGE.size;
    ops.push({ op: 'text', text: content.badge, x: PAD, y, font: BADGE, color: colors.primary });
  }

  // Divider, then the code on the right and the hint on the left, centred on the code.
  y += 32;
  ops.push({
    op: 'line',
    x1: PAD,
    y1: y,
    x2: PAD + INNER,
    y2: y,
    color: colors.placeholder,
    width: 2,
  });
  y += 28;
  const codeX = PAD + INNER - CODE;
  ops.push({
    op: 'rect',
    x: codeX,
    y,
    w: CODE,
    h: CODE,
    color: colors.placeholder,
    radius: CODE / 2,
  });
  ops.push({ op: 'image', key: 'code', x: codeX, y, w: CODE, h: CODE, radius: CODE / 2 });
  const middle = y + CODE / 2;
  ops.push({
    op: 'text',
    text: '长按识别小程序码',
    x: PAD,
    y: middle - 6,
    font: HINT,
    color: colors.text,
  });
  const sub =
    wrapText(`来自 ${content.shopName}`, INNER - CODE - 24, 1, HINT_SUB, measure)[0] ?? '';
  ops.push({ op: 'text', text: sub, x: PAD, y: middle + 30, font: HINT_SUB, color: colors.muted });
  y += CODE + PAD;

  return {
    width: POSTER_WIDTH,
    height: y,
    ops: [{ op: 'rect', x: 0, y: 0, w: POSTER_WIDTH, h: y, color: colors.background }, ...ops],
  };
}
