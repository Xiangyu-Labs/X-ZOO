import { describe, expect, it } from 'vitest';

import { blankSku } from './product-sku-editor';
import { shownPrice } from './product-preview';

describe('the preview’s price', () => {
  it('is the first spec a shopper can buy, with its 原价, skipping hidden and sold-out ones', () => {
    const pink = { ...blankSku({ 款式: '粉' }), price: '78.99', originalPrice: '99.00', stock: 0 };
    const purple = { ...blankSku({ 款式: '紫' }), price: '9.90', originalPrice: '19.90', stock: 2 };
    const black = { ...blankSku({ 款式: '黑' }), price: '1.00', stock: 5, isVisible: false };
    const white = { ...blankSku({ 款式: '白' }), price: '', stock: 5 };
    expect(shownPrice([black, white, pink, purple])).toEqual({
      price: '9.90',
      originalPrice: '19.90',
    });
    expect(shownPrice([{ ...pink, stock: 3 }, purple])).toEqual({
      price: '78.99',
      originalPrice: '99.00',
    });
    // 排序 decides which is first, not the row order.
    expect(
      shownPrice([
        { ...pink, stock: 3, sortOrder: 2 },
        { ...purple, sortOrder: 1 },
      ])?.price,
    ).toBe('9.90');
  });

  it('is the first spec when every one is sold out, rather than nothing', () => {
    const pink = { ...blankSku({ 款式: '粉' }), price: '78.99', stock: 0 };
    const purple = { ...blankSku({ 款式: '紫' }), price: '9.90', stock: 0 };
    expect(shownPrice([pink, purple])?.price).toBe('78.99');
  });

  it('is absent while no price is filled in', () => {
    expect(shownPrice([blankSku()])).toBeNull();
  });
});
